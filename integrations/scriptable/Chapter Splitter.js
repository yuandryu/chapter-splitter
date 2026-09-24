// Scriptable: create jobs and query their state for the Chapter Splitter shortcut.
// Create a File Bookmark named "chapter-splitter-queue" for the queue root first.

const BOOKMARK = 'chapter-splitter-queue'
// Set these before installing the script in Scriptable.
// The API should expose POST/GET /api/jobs as documented in SHORTCUTS.md.
const WEB_API_BASE = 'https://YOUR-RENDER-SERVICE.onrender.com/api'
const WEB_API_TOKEN = ''
const allowedExtensions = new Set(['pdf', 'epub'])

function fail(message) { throw new Error(message) }
function input() {
  const value = args.shortcutParameter
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch (_) { fail('快捷指令参数必须是 JSON。') }
  }
  return value || {}
}
function validJobId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{12,80}$/.test(value) }
function newJobId() { return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
function output(value) { Script.setShortcutOutput(JSON.stringify(value)); Script.complete() }
function apiUrl(path) { return `${WEB_API_BASE.replace(/\/$/, '')}${path}` }
function apiHeaders() { return WEB_API_TOKEN ? { Authorization: `Bearer ${WEB_API_TOKEN}` } : {} }
async function apiJSON(request) {
  try {
    const text = await request.loadString()
    let value
    try { value = JSON.parse(text) } catch (_) { return { state: 'failed', fallbackAvailable: true, errorCode: `HTTP_${request.response.statusCode}`, message: `云端返回了无法解析的响应（HTTP ${request.response.statusCode}）。` } }
    if (request.response.statusCode < 200 || request.response.statusCode >= 300) {
      return { state: 'failed', fallbackAvailable: true, errorCode: value.errorCode || `HTTP_${request.response.statusCode}`, message: value.message || '云端请求失败。' }
    }
    if (typeof value.resultUrl === 'string' && value.resultUrl.startsWith('/')) value.resultUrl = apiUrl(value.resultUrl)
    return value
  } catch (error) {
    return { state: 'failed', fallbackAvailable: true, errorCode: 'NETWORK_ERROR', message: `无法连接云端：${error.message || error}` }
  }
}

async function main() {
  const request = input()
  const fm = FileManager.iCloud()
  if (!fm.bookmarkExists(BOOKMARK)) fail(`请先在快捷指令中创建名为“${BOOKMARK}”的 File Bookmark。`)
  const root = fm.bookmarkedPath(BOOKMARK)
  const inbox = fm.joinPath(root, 'inbox')
  const jobs = fm.joinPath(root, 'jobs')
  const action = request.action || 'new-job'

  if (action === 'new-job') return output({ jobId: newJobId() })
  if (!validJobId(request.jobId)) fail('任务 ID 无效。')

  if (action === 'queue') {
    const extension = String(request.extension || '').toLowerCase().replace(/^\./, '')
    if (!allowedExtensions.has(extension)) fail('只支持 PDF 或 EPUB。')
    fm.createDirectory(inbox, true); fm.createDirectory(jobs, true)
    const file = fm.joinPath(inbox, `${request.jobId}.${extension}`)
    if (!fm.fileExists(file)) fail(`未找到输入文件：${request.jobId}.${extension}`)
    await fm.downloadFileFromiCloud(file)
    const job = fm.joinPath(jobs, `${request.jobId}.json`)
    fm.writeString(job, JSON.stringify({ state: 'queued', message: '已由 iPhone 入队，等待 Mac。', updatedAt: new Date().toISOString() }, null, 2))
    return output({ jobId: request.jobId, state: 'queued' })
  }

  if (action === 'web-submit') {
    const extension = String(request.extension || '').toLowerCase().replace(/^\./, '')
    if (!allowedExtensions.has(extension)) fail('只支持 PDF 或 EPUB。')
    const file = fm.joinPath(inbox, `${request.jobId}.${extension}`)
    if (!fm.fileExists(file)) fail(`未找到输入文件：${request.jobId}.${extension}`)
    await fm.downloadFileFromiCloud(file)
    const requestUrl = apiUrl(`/jobs?jobId=${encodeURIComponent(request.jobId)}&extension=${extension}`)
    const webRequest = new Request(requestUrl)
    webRequest.method = 'POST'
    webRequest.headers = { ...apiHeaders(), 'Content-Type': extension === 'pdf' ? 'application/pdf' : 'application/epub+zip' }
    webRequest.body = fm.read(file)
    const result = await apiJSON(webRequest)
    return output({ ...result, localJobId: request.jobId, backend: 'web' })
  }

  if (action === 'web-status') {
    if (typeof request.webJobId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request.webJobId)) fail('云端任务 ID 无效。')
    const webRequest = new Request(apiUrl(`/jobs/${encodeURIComponent(request.webJobId)}`))
    webRequest.headers = apiHeaders()
    const result = await apiJSON(webRequest)
    return output({ ...result, webJobId: request.webJobId, backend: 'web' })
  }

  if (action === 'web-cancel') {
    if (typeof request.webJobId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(request.webJobId)) fail('云端任务 ID 无效。')
    const webRequest = new Request(apiUrl(`/jobs/${encodeURIComponent(request.webJobId)}`))
    webRequest.method = 'DELETE'; webRequest.headers = apiHeaders()
    return output(await apiJSON(webRequest))
  }

  if (action === 'status') {
    const job = fm.joinPath(jobs, `${request.jobId}.json`)
    if (!fm.fileExists(job)) fail('未找到任务状态文件。')
    await fm.downloadFileFromiCloud(job)
    return output({ jobId: request.jobId, ...JSON.parse(fm.readString(job)) })
  }
  fail('未知操作。')
}

await main()
