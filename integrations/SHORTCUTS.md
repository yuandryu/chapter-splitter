# iPhone/iPad 快捷指令：Mac 兜底

> 云端上传现已统一从网页完成，不再通过快捷指令或 Scriptable 上传原文件。请先阅读 [`../cloud/WEB_UPLOAD.md`](../cloud/WEB_UPLOAD.md)。本文件中的 `web-submit`、`web-status` 与 ZIP 下载流程只保留为旧版参考；快捷指令的现行云端动作仅需“打开 URL”到网页首页。

```text
快捷指令 → Scriptable 将原文件放入 iCloud inbox
         → Render 云端 API 上传并处理
         → 成功：下载云端 ZIP
         → 失败/超时：询问用户
             └─ 使用 Mac：SSH 触发现有 Mac 队列
```

## 1. 云端部署目标

免费平台选择 **Render Free Web Service**。它支持完整 Node.js 服务，但空闲 15 分钟会休眠，唤醒通常需要约一分钟；实例文件系统也是临时的。因此云端 API 必须把任务结果放在响应可访问的对象存储或短期结果服务中，不能把本地磁盘当作永久存储。[Render Free 限制](https://render.com/docs/free)

API 地址部署后类似：`https://chapter-splitter-xxxx.onrender.com/api`

```text
POST   /api/jobs?jobId=<本地任务ID>&extension=pdf|epub
       请求体：原始 PDF/EPUB 二进制
GET    /api/jobs/<云端任务ID>
       返回 queued | processing | succeeded | failed
GET    /api/jobs/<云端任务ID>/result
       返回 ZIP
DELETE /api/jobs/<云端任务ID>
       取消任务
```

失败响应应包含 `state`、`errorCode`、`message` 和 `fallbackAvailable: true`。

## 2. 统一任务 ID 与目录

`localJobId` 是 iPhone/iPad、iCloud 和 Mac 端唯一的任务 ID；`webJobId` 只保存在任务记录中，不能用于 iCloud 的文件名。

```text
iCloud Drive / Scriptable / Chapter Splitter /
  inbox/<localJobId>-<原文件名>      原文件
  jobs/<localJobId>.json            任务总账（含 webJobId）
  results/<localJobId>-<原文件主名>-chapters.zip  云端或 Mac 的最终结果
```

任务记录同时保存原始文件名、原文件路径、云端 ID、云端状态、Mac 状态和最终 ZIP 路径。所有更新都必须合并写入这一个 JSON 文件。

## 3. 安装 Scriptable

1. 在 Scriptable 新建脚本，命名为 `Chapter Splitter`。
2. 粘贴 [`scriptable/Chapter Splitter.js`](./scriptable/Chapter%20Splitter.js)。
3. 修改脚本顶部的 `WEB_API_BASE` 为 Render API 地址。
4. 将 `WEB_API_TOKEN` 设置为云端 API 的个人访问令牌；不要提交到 Git 或公开分享脚本。
5. 此版本直接使用 Scriptable 的 iCloud Documents 目录：`iCloud Drive/Scriptable/Chapter Splitter`，无需创建 File Bookmark。

Scriptable 的 `Request` 支持直接把文件数据作为 HTTP 请求体，脚本会先下载尚未落地的 iCloud 文件。[Scriptable Request](https://docs.scriptable.app/request/)、[Scriptable FileManager](https://docs.scriptable.app/filemanager/)

## 4. 创建「拆分书籍」快捷指令

快捷指令设为接收 PDF/EPUB 文件并在共享表单显示：

1. 获取文件扩展名；不是 `pdf` 或 `epub` 就停止。
2. 运行 Scriptable，输入下列 JSON，取得纯文本的 `localJobId`：

   ```json
   {"action":"new-job","extension":"<扩展名>","originalName":"<原始文件名>"}
   ```

3. 将原文件重命名为 `localJobId-原文件名`，例如 `job-abc-我的书.pdf`。
4. 存储到 iCloud Drive 的 `Scriptable/Chapter Splitter/inbox`。这一步必须在云端上传前完成，保证云端失败后仍可切换 Mac。
5. 运行 Scriptable：

   ```json
   {"action":"web-submit","jobId":"<localJobId>","extension":"<扩展名>"}
   ```

6. `web-submit` 的输出仍是 `webJobId`。继续把它保存到快捷指令变量，并按你现有的 URL 方式轮询：

   ```json
   https://chapter-splitter-api.onrender.com/api/jobs/<webJobId>
   ```

   使用“获取 URL 内容 → 从输入中获取字典 → 获取 `state` 的值”取得状态。建议最多轮询 60 次。每轮后可选地运行下列 Scriptable 操作，把状态写回任务总账：

   ```json
   {"action":"record-web-state","jobId":"<localJobId>","state":"<webState>"}
   ```

   状态为 `succeeded` 时，继续用 Text 拼接下载地址：

   ```text
   https://chapter-splitter-api.onrender.com/api/jobs/<webJobId>/result
   ```

   用“获取 URL 内容”下载 ZIP 后，先运行 `result-file-name` 取得 ZIP 名称，再将文件保存为 `Scriptable/Chapter Splitter/results/<该输出名称>`，然后运行：

   ```json
   {"action":"mark-result","jobId":"<localJobId>","fileName":"<该输出名称>"}
   ```
7. 状态为 `failed`、请求超时或网络错误时，询问用户：`云端处理失败，是否使用 Mac 后端？`
8. 用户选择“是”则运行 Scriptable：

   ```json
   {"action":"queue","jobId":"<localJobId>","extension":"<扩展名>"}
   ```

9. 再执行“通过 SSH 运行脚本”：

   ```bash
   /绝对路径/chapter-splitter/mac/enqueue-job.sh '<localJobId>'
   ```

10. 按原来的 Mac 状态流程轮询 `queued → waiting → running → succeeded/failed`。

云端成功后可删除 `inbox/<localJobId>-<原文件名>`；切换 Mac 前不要删除它。

### 截图中需要替换的动作

第一张图无需改动：`web-submit` 会继续输出 `webJobId`，并同时自动写入 `jobs/<localJobId>.json`。因此这个变量可以继续用于快捷指令内拼接云端 URL，但 iCloud 文件和可恢复任务仍只以 `localJobId` 命名。

第二张图中“Text（拼接 `.../jobs/<webJobId>`）→ 获取 URL 内容 → 获取字典 → 获取 `state`”的整段动作可以原样保留。建议在“Set Variable `webState`”后追加：

1. Text：`{"action":"record-web-state","jobId":"<localJobId>","state":"<webState>"}`。
2. Run `Chapter Splitter` with Text。

下载结果时同样保留 `.../jobs/<webJobId>/result` 的 Text 拼接方式。先运行 `{"action":"result-file-name","jobId":"<localJobId>"}`，用输出重命名 ZIP 后保存到 `results/`，再运行 `mark-result` 更新任务总账。

## 5. Mac 兜底

Mac 端的 [enqueue-job.sh](../mac/enqueue-job.sh)、[run-job.sh](../mac/run-job.sh) 和 iCloud 队列流程可以继续使用。Mac 只在用户选择兜底后被调用。

## 6. 任务状态

快捷指令只需要长期保留一个 ID：

```text
localJobId：iCloud、云端映射、Mac 队列和结果文件均使用
webJobId：只保存在 `jobs/<localJobId>.json` 的 `web.jobId` 字段
```

不要直接写整个状态文件。Scriptable 与 Mac 都会合并更新 `jobs/<localJobId>.json`，因此切换到 Mac 兜底不会丢失云端映射和原始文件信息。

## 重要限制

- Render Free 首次请求可能因为休眠增加约一分钟等待。
- Render Free 的本地文件系统不可靠，API 必须使用外部/响应式结果存储，并设置过期清理。
- 云端 API 需要 HTTPS 和个人令牌；不要设为无认证公共上传端点。
- 当前 PDF CLI 使用 macOS PDFKit。要让 Render 真正执行 PDF，云端 worker 还需要改为跨平台的 PDF.js/pdf-lib 或其他 Node/Python PDF 引擎；EPUB 部分较容易迁移。
