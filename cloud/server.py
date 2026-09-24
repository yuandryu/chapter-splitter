import copy
import json
import os
import posixpath
import re
import shutil
import tempfile
import threading
import uuid
import zipfile
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree as ET

import fitz
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse

app = FastAPI(title="Chapter Splitter API")
JOBS = {}
LOCK = threading.Lock()
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))


def now_state(job_id, **values):
    with LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)
            JOBS[job_id]["updatedAt"] = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()


def auth(request: Request):
    expected = os.environ.get("API_TOKEN", "").strip()
    if expected and request.headers.get("authorization", "") != f"Bearer {expected}":
        return JSONResponse({"state": "failed", "errorCode": "UNAUTHORIZED", "message": "API token 无效。"}, status_code=401)
    return None


def safe_name(value):
    value = re.sub(r'[\\/:*?"<>|]+', "-", value).strip()[:100]
    return value or "Untitled chapter"


def chapter_title(line):
    line = re.sub(r"\s+", " ", line).strip()
    if not re.match(r"^(第[〇零一二三四五六七八九十百千0-9]+[章节篇部卷]|chapter\s+[0-9ivxlcdm]+\b|part\s+[0-9ivxlcdm]+\b)", line, re.I):
        return None
    if "…" in line or "...." in line or re.search(r"\.{2,}\s*\d+\s*$", line):
        return None
    return line


def pdf_chapters(source, output):
    document = fitz.open(source)
    starts = []
    toc = document.get_toc(simple=False) or []
    if toc:
        top_level = min(row[0] for row in toc if len(row) >= 3 and row[2] > 0)
        starts = [{"title": row[1], "start_page": row[2], "source": "outline", "confidence": "high"} for row in toc if row[0] == top_level and row[2] > 0]
    if not starts:
        for index in range(document.page_count):
            for line in (document[index].get_text("text") or "").splitlines():
                title = chapter_title(line)
                if title:
                    starts.append({"title": title, "start_page": index + 1, "source": "heading", "confidence": "medium"})
                    break
    unique = []
    for item in sorted(starts, key=lambda row: row["start_page"]):
        if not unique or unique[-1]["start_page"] != item["start_page"]:
            unique.append(item)
    if not unique:
        raise ValueError("没有找到可用书签或章节标题；扫描 PDF 需要先 OCR 或添加书签。")
    chapters = []
    for index, item in enumerate(unique):
        start = item["start_page"] - 1
        end = (unique[index + 1]["start_page"] - 2) if index + 1 < len(unique) else document.page_count - 1
        piece = fitz.open()
        piece.insert_pdf(document, from_page=start, to_page=end)
        filename = f"{index + 1:03d}-{safe_name(item['title'])}.pdf"
        piece.save(str(output / filename), garbage=4, deflate=True)
        try:
            label = document[start].get_label() or str(item["start_page"])
        except Exception:
            label = str(item["start_page"])
        chapters.append({**item, "end_page": end + 1, "page_label": label, "file": filename})
        piece.close()
    document.close()
    return chapters


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def norm_href(base, href):
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), unquote(href.split("#", 1)[0]))).lstrip("./")


def epub_chapters(source, output):
    stage = Path(tempfile.mkdtemp(prefix="chapter-split-epub-"))
    try:
        with zipfile.ZipFile(source) as archive:
            archive.extractall(stage)
        container = ET.parse(stage / "META-INF" / "container.xml")
        rootfile = next((node for node in container.iter() if local_name(node.tag) == "rootfile"), None)
        if rootfile is None or not rootfile.attrib.get("full-path"):
            raise ValueError("EPUB 缺少 OPF 定位信息。")
        opf_rel = rootfile.attrib["full-path"]
        opf_path = stage / opf_rel
        tree = ET.parse(opf_path)
        package = tree.getroot()
        manifest = {}
        spine_node = None
        for node in package.iter():
            if local_name(node.tag) == "item" and node.attrib.get("id") and node.attrib.get("href"):
                manifest[node.attrib["id"]] = node.attrib
            if local_name(node.tag) == "spine":
                spine_node = node
        if spine_node is None:
            raise ValueError("EPUB 缺少 spine。")
        spine = [node.attrib.get("idref") for node in spine_node if local_name(node.tag) == "itemref" and node.attrib.get("idref")]
        if not spine:
            raise ValueError("EPUB spine 不含可阅读内容。")
        nav = next((attrs for attrs in manifest.values() if "nav" in attrs.get("properties", "").split()), None)
        toc_id = spine_node.attrib.get("toc")
        source_item = nav or manifest.get(toc_id)
        entries = []
        if source_item:
            nav_rel = norm_href(opf_rel, source_item["href"])
            nav_path = stage / nav_rel
            nav_tree = ET.parse(nav_path)
            path_to_id = {norm_href(opf_rel, attrs["href"]): item_id for item_id, attrs in manifest.items()}
            spine_index = {item_id: index for index, item_id in enumerate(spine)}
            for node in nav_tree.iter():
                if local_name(node.tag) != "a" or not node.attrib.get("href"):
                    continue
                item_id = path_to_id.get(norm_href(nav_rel, node.attrib["href"]))
                if item_id in spine_index:
                    title = " ".join("".join(node.itertext()).split()) or item_id
                    entries.append({"title": title, "index": spine_index[item_id]})
        if not entries:
            entries = [{"title": Path(manifest[item]["href"]).stem, "index": index} for index, item in enumerate(spine)]
        starts = [item for index, item in enumerate(entries) if index == 0 or item["index"] != entries[index - 1]["index"]]
        chapters = []
        for index, item in enumerate(starts):
            end = starts[index + 1]["index"] if index + 1 < len(starts) else len(spine)
            selected = set(spine[item["index"]:end])
            chapter_tree = copy.deepcopy(tree)
            chapter_spine = next(node for node in chapter_tree.getroot().iter() if local_name(node.tag) == "spine")
            for child in list(chapter_spine):
                if local_name(child.tag) == "itemref":
                    chapter_spine.remove(child)
            for item_id in spine[item["index"]:end]:
                chapter_spine.append(ET.Element("itemref", {"idref": item_id}))
            chapter_tree.write(opf_path, encoding="utf-8", xml_declaration=True)
            filename = f"{index + 1:03d}-{safe_name(item['title'])}.epub"
            with zipfile.ZipFile(output / filename, "w", zipfile.ZIP_DEFLATED) as archive:
                mimetype = stage / "mimetype"
                if mimetype.exists():
                    archive.write(mimetype, "mimetype", compress_type=zipfile.ZIP_STORED)
                for path in stage.rglob("*"):
                    if path.is_file() and path != mimetype:
                        archive.write(path, path.relative_to(stage).as_posix())
            chapters.append({"title": item["title"], "start_spine_index": item["index"] + 1, "end_spine_index": end, "source": "navigation" if source_item else "spine", "confidence": "high" if source_item else "medium", "file": filename})
            tree.write(opf_path, encoding="utf-8", xml_declaration=True)
        return chapters
    finally:
        shutil.rmtree(stage, ignore_errors=True)


def process_job(web_id, input_path, extension, job_dir):
    try:
        now_state(web_id, state="processing", message="正在识别章节并切分文件。", progress=0.1)
        output = Path(job_dir) / "result"
        output.mkdir()
        chapters = pdf_chapters(input_path, output) if extension == "pdf" else epub_chapters(input_path, output)
        manifest = {"format": extension, "chapters": chapters}
        (output / "chapters.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        archive = Path(job_dir) / f"{web_id}.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as target:
            for path in output.rglob("*"):
                if path.is_file():
                    target.write(path, path.relative_to(output).as_posix())
        now_state(web_id, state="succeeded", progress=1, message="处理完成。", resultUrl=f"/api/jobs/{web_id}/result", archive=str(archive))
    except Exception as error:
        now_state(web_id, state="failed", progress=1, errorCode="PROCESSING_FAILED", message=str(error), fallbackAvailable=True)


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "chapter-splitter-api"}


@app.post("/api/jobs")
async def create_job(request: Request):
    denied = auth(request)
    if denied:
        return denied
    extension = request.query_params.get("extension", "").lower().lstrip(".")
    if extension not in {"pdf", "epub"}:
        return JSONResponse({"state": "failed", "errorCode": "UNSUPPORTED_FORMAT", "message": "只支持 PDF 或 EPUB。", "fallbackAvailable": True}, status_code=400)
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        return JSONResponse({"state": "failed", "errorCode": "FILE_TOO_LARGE", "message": "文件超过云端免费额度限制。", "fallbackAvailable": True}, status_code=413)
    web_id = f"web-{uuid.uuid4().hex}"
    job_dir = Path(tempfile.mkdtemp(prefix=f"{web_id}-"))
    input_path = job_dir / f"input.{extension}"
    input_path.write_bytes(body)
    JOBS[web_id] = {"jobId": web_id, "state": "queued", "message": "云端任务已创建。", "fallbackAvailable": True, "updatedAt": ""}
    threading.Thread(target=process_job, args=(web_id, input_path, extension, job_dir), daemon=True).start()
    return {**JOBS[web_id], "jobId": web_id}


@app.get("/api/jobs/{web_id}")
async def get_job(web_id: str, request: Request):
    denied = auth(request)
    if denied:
        return denied
    job = JOBS.get(web_id)
    if not job:
        return JSONResponse({"state": "failed", "errorCode": "NOT_FOUND", "message": "任务不存在。", "fallbackAvailable": True}, status_code=404)
    return job


@app.get("/api/jobs/{web_id}/result")
async def get_result(web_id: str, request: Request):
    denied = auth(request)
    if denied:
        return denied
    job = JOBS.get(web_id)
    if not job or job.get("state") != "succeeded" or not Path(job.get("archive", "")).is_file():
        return JSONResponse({"state": "failed", "errorCode": "NOT_READY", "message": "结果尚未准备好。"}, status_code=409)
    return FileResponse(job["archive"], media_type="application/zip", filename=f"{web_id}.zip")


@app.delete("/api/jobs/{web_id}")
async def delete_job(web_id: str, request: Request):
    denied = auth(request)
    if denied:
        return denied
    if web_id in JOBS:
        now_state(web_id, state="cancelled", message="任务已取消。")
    return {"jobId": web_id, "state": "cancelled"}
