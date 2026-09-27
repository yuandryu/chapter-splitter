# 旧版 Scriptable 直传 API（已弃用）

> 云端主路径现已统一改为网页上传 + R2 分片存储。请使用 [`WEB_UPLOAD.md`](./WEB_UPLOAD.md) 部署和操作；本文件保留仅供旧版快捷指令/Mac 兜底排查。

这一目录提供快捷指令所需的云端主处理 API。Render Free 支持 Python Web Service，但免费实例空闲 15 分钟会休眠，且本地文件系统会在重启/休眠/重新部署时丢失；本实现只把任务和 ZIP 保存在当前实例内存/临时目录中，适合个人、短任务测试，不适合长期生产存储。[Render Free 限制](https://render.com/docs/free)

## 部署

1. 将 `chapter-splitter` 推送到一个 GitHub 仓库。
2. 在 Render 选择 **New → Blueprint**，选择该仓库。
3. Render 会读取根目录的 `render.yaml`，创建 Free Web Service。
4. 在服务环境变量中设置随机的 `API_TOKEN`。
5. 部署后复制服务 URL，例如 `https://chapter-splitter-api.onrender.com`。
6. 在 Scriptable 脚本顶部设置：

   ```javascript
   const WEB_API_BASE = 'https://chapter-splitter-api.onrender.com/api'
   const WEB_API_TOKEN = '同一个 API_TOKEN'
   ```

7. 用以下地址确认服务：

   ```text
   https://你的服务.onrender.com/api/health
   ```

## 本地运行

```bash
cd cloud
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
API_TOKEN=dev-token uvicorn server:app --reload --port 8787
```

本地 API 地址为 `http://127.0.0.1:8787/api`。生产环境必须使用 HTTPS 和 API token。

## 免费版边界

- `MAX_UPLOAD_BYTES` 默认 100 MB。
- 服务休眠后首次请求可能需要等待约一分钟。
- Render 免费实例重启时会丢失正在处理的任务和结果。
- 任务失败或超时后，快捷指令会询问是否切换到 Mac 后端。
- 若要长期保存结果，需要增加外部对象存储或数据库；不要把 Render 本地目录当作永久文件存储。
