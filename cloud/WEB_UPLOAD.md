# 网页统一上传（R2）部署说明

`server_r2.py` 是新的云端入口。所有 PDF/EPUB 都从浏览器直接分片上传到 Cloudflare R2；Render 只负责目录分析与切分，因此快捷指令和 Scriptable 不再传输原文件。

## Render 环境变量

在原有 `API_TOKEN` 之外设置以下变量。R2 API Token 应只授予此 bucket 的 Object Read & Write 权限。

```text
R2_ACCOUNT_ID=<Cloudflare Account ID>
R2_ACCESS_KEY_ID=<R2 S3 API Token 的 Access Key ID>
R2_SECRET_ACCESS_KEY=<R2 S3 API Token 的 Secret Access Key>
R2_BUCKET=chapter-splitter
MAX_UPLOAD_BYTES=1073741824
UPLOAD_PART_SIZE=10485760
```

`render.yaml` 已改为启动 `server_r2:app`。旧的 `server.py` 没有删除；若需紧急回退，只需把 Start Command 改回 `uvicorn server:app --host 0.0.0.0 --port $PORT`。

## R2 CORS

在 R2 bucket 的 **Settings → CORS Policy** 填入以下内容，并把 `https://chapter-splitter-api.onrender.com` 替换为实际 Render 域名。`ETag` 必须暴露给网页，否则浏览器无法完成分片合并。

```json
[
  {
    "AllowedOrigins": ["https://chapter-splitter-api.onrender.com"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## 使用方式

部署后打开 Render 服务根地址，而不是 `/api/health`：

```text
https://chapter-splitter-api.onrender.com/
```

选择 PDF 或 EPUB 后，网页会分片直传 R2。PDF 上传完成后：

- 有可用书签或章节标题：预填章节表，可直接处理，也可以修改后处理；
- 无可用目录：填写每章的名称与 **PDF 实际起始页**，保存后处理；
- 起始页必须为 1 到总 PDF 页数，且严格递增。结束页自动以“下一章起始页 - 1”计算。

手动页码目前仅适用于 PDF；EPUB 继续按导航目录或 spine 自动切分。

网页首次访问会要求填入 `API_TOKEN`；它只保存在该设备浏览器的 localStorage，并用于调用 Render API。R2 上传链接本身是一次性、限时的签名链接，不会在网页中暴露 R2 密钥。

## 快捷指令调整

云端路径不再调用 Scriptable 的 `web-submit`、`web-status` 或 `web-result-url`。快捷指令只需提供“打开 URL”动作，地址为上面的网页根地址；大文件也从网页选择并上传。原来的 iCloud inbox + Scriptable `queue` + SSH Mac 队列保持不变，作为网页失败时的兜底。

iOS 不允许快捷指令把共享表单中的文件自动预填到 Safari 的网页文件选择器，因此用户需要在网页中重新选择该文件。这是为了换取大文件的可靠上传与可重试能力。

## 清理

为 bucket 添加生命周期规则，删除 `sources/`、`results/` 和 `jobs/` 下超过 1–7 天的对象，避免累积存储费用与隐私风险。
