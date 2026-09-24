# iPhone/iPad 快捷指令：云端优先，Mac 兜底

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

## 2. 安装 Scriptable

1. 在 Scriptable 新建脚本，命名为 `Chapter Splitter`。
2. 粘贴 [`scriptable/Chapter Splitter.js`](./scriptable/Chapter%20Splitter.js)。
3. 修改脚本顶部的 `WEB_API_BASE` 为 Render API 地址。
4. 将 `WEB_API_TOKEN` 设置为云端 API 的个人访问令牌；不要提交到 Git 或公开分享脚本。
5. 新建一次性快捷指令“配置 Chapter Splitter”：选择 iCloud Drive 的 `Shortcuts/Chapter Splitter`，执行 Scriptable 的 **Create File Bookmark**，名称为 `chapter-splitter-queue`。

Scriptable 的 `Request` 支持直接把文件数据作为 HTTP 请求体，脚本会先下载尚未落地的 iCloud 文件。[Scriptable Request](https://docs.scriptable.app/request/)、[Scriptable FileManager](https://docs.scriptable.app/filemanager/)

## 3. 创建「拆分书籍」快捷指令

快捷指令设为接收 PDF/EPUB 文件并在共享表单显示：

1. 获取文件扩展名；不是 `pdf` 或 `epub` 就停止。
2. 运行 Scriptable，输入 `{"action":"new-job"}`，取得 `jobId`。
3. 将原文件重命名为 `jobId.扩展名`。
4. 存储到 iCloud Drive 的 `Shortcuts/Chapter Splitter/inbox`。这一步必须在云端上传前完成，保证云端失败后仍可切换 Mac。
5. 运行 Scriptable：

   ```json
   {"action":"web-submit","jobId":"<jobId>","extension":"<扩展名>"}
   ```

6. 取得 `webJobId`，每隔 5 秒运行 Scriptable：

   ```json
   {"action":"web-status","webJobId":"<webJobId>"}
   ```

   建议最多轮询 60 次；状态为 `succeeded` 时下载 `resultUrl` 或调用 `/result`。
7. 状态为 `failed`、请求超时或网络错误时，询问用户：`云端处理失败，是否使用 Mac 后端？`
8. 用户选择“是”则运行 Scriptable：

   ```json
   {"action":"queue","jobId":"<jobId>","extension":"<扩展名>"}
   ```

9. 再执行“通过 SSH 运行脚本”：

   ```bash
   /绝对路径/chapter-splitter/mac/enqueue-job.sh '<jobId>'
   ```

10. 按原来的 Mac 状态流程轮询 `queued → waiting → running → succeeded/failed`。

云端成功后可删除 `inbox/<jobId>.*`；切换 Mac 前不要删除它。

## 4. Mac 兜底

Mac 端的 [enqueue-job.sh](../mac/enqueue-job.sh)、[run-job.sh](../mac/run-job.sh) 和 iCloud 队列流程可以继续使用。Mac 只在用户选择兜底后被调用。

## 5. 任务状态

快捷指令需要同时保留两个 ID：

```text
localJobId：iCloud/Mac 队列使用
webJobId：云端 API 使用
```

不要用云端失败状态覆盖 Mac 的 `jobs/<localJobId>.json`，否则用户选择 Mac 兜底时会丢失本地任务状态。

## 重要限制

- Render Free 首次请求可能因为休眠增加约一分钟等待。
- Render Free 的本地文件系统不可靠，API 必须使用外部/响应式结果存储，并设置过期清理。
- 云端 API 需要 HTTPS 和个人令牌；不要设为无认证公共上传端点。
- 当前 PDF CLI 使用 macOS PDFKit。要让 Render 真正执行 PDF，云端 worker 还需要改为跨平台的 PDF.js/pdf-lib 或其他 Node/Python PDF 引擎；EPUB 部分较容易迁移。
