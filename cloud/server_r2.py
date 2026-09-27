"""Web-first Chapter Splitter service.

Files go from the browser directly to Cloudflare R2 in multipart uploads.  The
Render process receives only JSON requests and downloads the source after the
upload is complete, so iOS Shortcuts is not in the large-file data path.
"""
import json
import math
import os
import re
import shutil
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import boto3
import fitz
from botocore.config import Config
from botocore.exceptions import ClientError
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from server import archive_name, chapter_title, epub_chapters, safe_name


app = FastAPI(title="Chapter Splitter Web API")
WEB_DIR = Path(__file__).parent / "web"
PART_SIZE = int(os.environ.get("UPLOAD_PART_SIZE", str(10 * 1024 * 1024)))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", str(1024 * 1024 * 1024)))
JOB_LOCKS, LOCK = {}, threading.Lock()


class StorageUnavailable(RuntimeError):
    pass


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def bucket():
    return os.environ.get("R2_BUCKET", "").strip()


def storage():
    account = os.environ.get("R2_ACCOUNT_ID", "").strip()
    key_id = os.environ.get("R2_ACCESS_KEY_ID", "").strip()
    secret = os.environ.get("R2_SECRET_ACCESS_KEY", "").strip()
    if not (account and key_id and secret and bucket()):
        raise StorageUnavailable("云端存储尚未配置。请设置 R2_ACCOUNT_ID、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 和 R2_BUCKET。")
    return boto3.client("s3", endpoint_url=f"https://{account}.r2.cloudflarestorage.com", aws_access_key_id=key_id, aws_secret_access_key=secret, region_name="auto", config=Config(signature_version="s3v4"))


def job_key(job_id): return f"jobs/{job_id}.json"
def source_key(job_id, extension): return f"sources/{job_id}/source.{extension}"
def result_key(job_id): return f"results/{job_id}/chapters.zip"


def auth(request):
    expected = os.environ.get("API_TOKEN", "").strip()
    if expected and request.headers.get("authorization", "") != f"Bearer {expected}":
        return JSONResponse({"state": "failed", "errorCode": "UNAUTHORIZED", "message": "API token 无效。"}, status_code=401)


def storage_error(error, status=503):
    return JSONResponse({"state": "failed", "fallbackAvailable": True, "errorCode": "STORAGE_UNAVAILABLE", "message": str(error)}, status_code=status)


def save_job(job):
    job["updatedAt"] = utc_now()
    storage().put_object(Bucket=bucket(), Key=job_key(job["jobId"]), Body=json.dumps(job, ensure_ascii=False).encode(), ContentType="application/json")
    return job


def load_job(job_id):
    try:
        response = storage().get_object(Bucket=bucket(), Key=job_key(job_id))
        return json.loads(response["Body"].read().decode())
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in {"NoSuchKey", "404", "NotFound"}:
            return None
        raise


def update_job(job_id, **patch):
    with JOB_LOCKS.setdefault(job_id, threading.Lock()):
        job = load_job(job_id)
        if not job: return None
        job.update(patch)
        return save_job(job)


def detect_pdf(source):
    document = fitz.open(source)
    try:
        starts = []
        toc = document.get_toc(simple=False) or []
        if toc:
            top_level = min(row[0] for row in toc if len(row) >= 3 and row[2] > 0)
            starts = [{"title": row[1], "startPage": row[2], "source": "outline", "confidence": "high"} for row in toc if row[0] == top_level and row[2] > 0]
        if not starts:
            for page_index in range(document.page_count):
                for line in (document[page_index].get_text("text") or "").splitlines():
                    title = chapter_title(line)
                    if title:
                        starts.append({"title": title, "startPage": page_index + 1, "source": "heading", "confidence": "medium"})
                        break
        unique = []
        for item in sorted(starts, key=lambda value: value["startPage"]):
            if not unique or unique[-1]["startPage"] != item["startPage"]: unique.append(item)
        return {"pageCount": document.page_count, "chapters": unique}
    finally:
        document.close()


def validate_chapters(value, page_count):
    if not isinstance(value, list) or not value: raise ValueError("至少需要一个章节。")
    chapters, last_page = [], 0
    for index, item in enumerate(value, 1):
        try: start_page = int(item.get("startPage"))
        except (AttributeError, TypeError, ValueError): raise ValueError(f"第 {index} 章的起始页无效。")
        if not 1 <= start_page <= page_count: raise ValueError(f"第 {index} 章的起始页必须在 1 到 {page_count} 之间。")
        if start_page <= last_page: raise ValueError("章节起始页必须严格递增。")
        chapters.append({"title": safe_name(str(item.get("title") or "")), "startPage": start_page, "source": "manual", "confidence": "user"})
        last_page = start_page
    return chapters


def split_pdf_manual(source, output, client_job_id, starts):
    document = fitz.open(source)
    try:
        chapters = []
        for index, item in enumerate(starts):
            start = item["startPage"] - 1
            end = starts[index + 1]["startPage"] - 2 if index + 1 < len(starts) else document.page_count - 1
            piece = fitz.open()
            piece.insert_pdf(document, from_page=start, to_page=end)
            filename = f"{index + 1:03d}-{client_job_id}-{safe_name(item['title'])}.pdf"
            piece.save(output / filename, garbage=4, deflate=True)
            chapters.append({**item, "endPage": end + 1, "pageLabel": document[start].get_label() or str(item["startPage"]), "file": filename})
            piece.close()
        return chapters
    finally:
        document.close()


def process_job(job_id):
    work = Path(tempfile.mkdtemp(prefix=f"{job_id}-"))
    try:
        job = update_job(job_id, state="processing", message="正在识别章节并切分文件。", progress=0.1)
        if not job or job.get("state") == "cancelled": return
        source = work / f"input.{job['extension']}"
        storage().download_file(bucket(), job["sourceKey"], str(source))
        output = work / "result"; output.mkdir()
        if job["extension"] == "pdf":
            chapters = split_pdf_manual(source, output, job.get("clientJobId") or job_id, job["chapters"])
        else:
            chapters = epub_chapters(source, output, job.get("clientJobId") or job_id)
        (output / "chapters.json").write_text(json.dumps({"format": job["extension"], "chapters": chapters}, ensure_ascii=False, indent=2), encoding="utf-8")
        archive = work / "chapters.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as target:
            for file in output.rglob("*"):
                if file.is_file(): target.write(file, file.relative_to(output).as_posix())
        storage().upload_file(str(archive), bucket(), result_key(job_id), ExtraArgs={"ContentType": "application/zip"})
        update_job(job_id, state="succeeded", message="处理完成。", progress=1, resultKey=result_key(job_id), resultUrl=f"/api/jobs/{job_id}/result", archiveName=archive_name(job.get("clientJobId") or job_id, job.get("originalName")))
    except Exception as error:
        update_job(job_id, state="failed", message=str(error), errorCode="PROCESSING_FAILED", progress=1, fallbackAvailable=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "chapter-splitter-web-api", "storageConfigured": bool(bucket())}


@app.post("/api/jobs")
async def create_job(request: Request):
    if denied := auth(request): return denied
    try:
        payload = await request.json()
        extension = str(payload.get("extension", "")).lower().lstrip(".")
        size = payload.get("size")
        if extension not in {"pdf", "epub"}: raise ValueError("只支持 PDF 或 EPUB。")
        if not isinstance(size, int) or not 0 < size <= MAX_UPLOAD_BYTES: raise ValueError("文件大小不在云端允许范围内。")
        client_job_id = str(payload.get("clientJobId") or "").strip() or None
        if client_job_id and not re.fullmatch(r"[A-Za-z0-9_-]{12,80}", client_job_id): raise ValueError("本地任务 ID 无效。")
        job_id, key = f"web-{uuid.uuid4().hex}", None
        key = source_key(job_id, extension)
        upload = storage().create_multipart_upload(Bucket=bucket(), Key=key, ContentType="application/pdf" if extension == "pdf" else "application/epub+zip")
        part_count = math.ceil(size / PART_SIZE)
        if part_count > 10000: raise ValueError("文件超过分片上传上限。")
        job = {"jobId": job_id, "clientJobId": client_job_id, "originalName": Path(str(payload.get("originalName") or "book")).name, "extension": extension, "size": size, "sourceKey": key, "multipartUploadId": upload["UploadId"], "state": "uploading", "message": "正在从浏览器上传原文件。", "progress": 0, "fallbackAvailable": True}
        save_job(job)
        urls = [storage().generate_presigned_url("upload_part", Params={"Bucket": bucket(), "Key": key, "UploadId": upload["UploadId"], "PartNumber": number}, ExpiresIn=3600, HttpMethod="PUT") for number in range(1, part_count + 1)]
        return {"jobId": job_id, "state": "uploading", "partSize": PART_SIZE, "uploadUrls": urls}
    except (StorageUnavailable, ClientError) as error: return storage_error(error)
    except ValueError as error: return storage_error(error, 400)


@app.post("/api/jobs/{job_id}/upload-complete")
async def upload_complete(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        job = load_job(job_id)
        if not job: raise HTTPException(404, "任务不存在。")
        parts = (await request.json()).get("parts")
        if not isinstance(parts, list) or not parts: raise ValueError("缺少上传分片。")
        storage().complete_multipart_upload(Bucket=bucket(), Key=job["sourceKey"], UploadId=job["multipartUploadId"], MultipartUpload={"Parts": [{"PartNumber": int(part["partNumber"]), "ETag": part["etag"]} for part in parts]})
        work = Path(tempfile.mkdtemp(prefix=f"{job_id}-inspect-"))
        try:
            source = work / f"input.{job['extension']}"; storage().download_file(bucket(), job["sourceKey"], str(source))
            if job["extension"] == "pdf":
                analysis = detect_pdf(source)
                state = "ready" if analysis["chapters"] else "awaiting_chapters"
                message = "已识别到章节；可直接开始，或改为手动编辑。" if analysis["chapters"] else "未找到可用目录，请手动输入章节名称和 PDF 实际起始页。"
                update_job(job_id, state=state, message=message, progress=.05, analysis=analysis, chapters=analysis["chapters"] or None)
            else:
                update_job(job_id, state="ready", message="EPUB 已上传，准备按导航目录切分。", progress=.05)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return load_job(job_id)
    except HTTPException as error: return JSONResponse({"state": "failed", "errorCode": "NOT_FOUND", "message": error.detail}, status_code=error.status_code)
    except (StorageUnavailable, ClientError) as error: return storage_error(error)
    except ValueError as error: return storage_error(error, 400)


@app.put("/api/jobs/{job_id}/chapters")
async def chapters(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        job = load_job(job_id)
        if not job: raise HTTPException(404, "任务不存在。")
        if job["extension"] != "pdf": raise ValueError("手动页码切分目前只支持 PDF。")
        values = validate_chapters((await request.json()).get("chapters"), job.get("analysis", {}).get("pageCount", 0))
        return update_job(job_id, state="ready", message="手动章节已保存，准备切分。", chapters=values)
    except HTTPException as error: return JSONResponse({"state": "failed", "errorCode": "NOT_FOUND", "message": error.detail}, status_code=error.status_code)
    except (StorageUnavailable, ClientError) as error: return storage_error(error)
    except ValueError as error: return storage_error(error, 400)


@app.post("/api/jobs/{job_id}/process")
async def start(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        job = load_job(job_id)
        if not job: return JSONResponse({"state": "failed", "errorCode": "NOT_FOUND", "message": "任务不存在。"}, status_code=404)
        if job["state"] not in {"ready", "awaiting_chapters"}: return JSONResponse({"state": "failed", "errorCode": "NOT_READY", "message": "任务尚不能开始处理。"}, status_code=409)
        if job["extension"] == "pdf" and not job.get("chapters"): return JSONResponse({"state": "failed", "errorCode": "CHAPTERS_REQUIRED", "message": "请先填写章节。"}, status_code=409)
        update_job(job_id, state="queued", message="已排队，等待云端处理。", progress=.05)
        threading.Thread(target=process_job, args=(job_id,), daemon=True).start()
        return load_job(job_id)
    except (StorageUnavailable, ClientError) as error: return storage_error(error)


@app.get("/api/jobs/{job_id}")
async def status(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        job = load_job(job_id)
        return job or JSONResponse({"state": "failed", "errorCode": "NOT_FOUND", "message": "任务不存在。"}, status_code=404)
    except (StorageUnavailable, ClientError) as error: return storage_error(error)


@app.get("/api/jobs/{job_id}/result")
async def result(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        job = load_job(job_id)
        if not job or job.get("state") != "succeeded": return JSONResponse({"state": "failed", "errorCode": "NOT_READY", "message": "结果尚未准备好。"}, status_code=409)
        url = storage().generate_presigned_url("get_object", Params={"Bucket": bucket(), "Key": job["resultKey"], "ResponseContentDisposition": f'attachment; filename="{job.get("archiveName") or "chapters.zip"}'}, ExpiresIn=3600)
        return RedirectResponse(url, status_code=302)
    except (StorageUnavailable, ClientError) as error: return storage_error(error)


@app.get("/api/jobs/{job_id}/result-url")
async def result_url(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        job = load_job(job_id)
        if not job or job.get("state") != "succeeded": return JSONResponse({"state": "failed", "errorCode": "NOT_READY", "message": "结果尚未准备好。"}, status_code=409)
        url = storage().generate_presigned_url("get_object", Params={"Bucket": bucket(), "Key": job["resultKey"], "ResponseContentDisposition": f'attachment; filename="{job.get("archiveName") or "chapters.zip"}'}, ExpiresIn=3600)
        return {"url": url}
    except (StorageUnavailable, ClientError) as error: return storage_error(error)


@app.delete("/api/jobs/{job_id}")
async def cancel(job_id: str, request: Request):
    if denied := auth(request): return denied
    try:
        if not load_job(job_id): return JSONResponse({"state": "failed", "errorCode": "NOT_FOUND", "message": "任务不存在。"}, status_code=404)
        return update_job(job_id, state="cancelled", message="任务已取消。")
    except (StorageUnavailable, ClientError) as error: return storage_error(error)


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
