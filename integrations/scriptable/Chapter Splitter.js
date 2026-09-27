// Scriptable: Chapter Splitter 的 iCloud 任务总账。
// iCloud Drive/Scriptable/Chapter Splitter 下的 inbox、jobs、results 都使用 localJobId 命名。
const WEB_API_BASE = 'https://chapter-splitter-api.onrender.com/api'
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
function output(value) { Script.setShortcutOutput(value); Script.complete() }
function apiUrl(path) { return `${WEB_API_BASE.replace(/\/$/, '')}${path}` }
function apiHeaders() { return WEB_API_TOKEN ? { Authorization: `Bearer ${WEB_API_TOKEN}` } : {} }
function extensionOf(value) { return String(value || '').toLowerCase().replace(/^\./, '') }
function safeFileName(value) { return String(value || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) }
function sourceFileName(localJobId, originalName, extension) {
  let name = safeFileName(originalName)
  if (!name) name = `book.${extension}`
  if (!name.toLowerCase().endsWith(`.${extension}`)) name = `${name}.${extension}`
  return `${localJobId}-${name}`
}
function resultFileName(localJobId, originalName) {
  const source = safeFileName(originalName) || 'book'
  const stem = source.replace(/\.[^.]+$/, '') || 'book'
  return `${localJobId}-${stem}-chapters.zip`
}
function ensureDirectories(fm, ...paths) { for (const path of paths) fm.createDirectory(path, true) }
function jobFile(fm, jobs, localJobId) { return fm.joinPath(jobs, `${localJobId}.json`) }
function inputFile(fm, inbox, localJobId, job, extension) {
  const stored = job.source && job.source.storedFile
  if (typeof stored === 'string' && stored.startsWith('inbox/')) return fm.joinPath(inbox, stored.slice('inbox/'.length))
  const prefix = `${localJobId}-`
  const match = fm.listContents(inbox).find(name => name.startsWith(prefix) && name.toLowerCase().endsWith(`.${extension}`))
  return fm.joinPath(inbox, match || `${localJobId}.${extension}`) // 兼容旧任务。
}
async function readJob(fm, jobs, localJobId) {
  const file = jobFile(fm, jobs, localJobId)
  if (!fm.fileExists(file)) return { localJobId }
  await fm.downloadFileFromiCloud(file)
  try { return { localJobId, ...JSON.parse(fm.readString(file)) } } catch (_) { fail(`任务记录损坏：${localJobId}`) }
}
function writeJob(fm, jobs, localJobId, patch) {
  const file = jobFile(fm, jobs, localJobId)
  let current = { localJobId }
  if (fm.fileExists(file)) {
    try { current = { localJobId, ...JSON.parse(fm.readString(file)) } } catch (_) { fail(`任务记录损坏：${localJobId}`) }
  }
  const next = {
    ...current,
    ...patch,
    localJobId,
    source: { ...(current.source || {}), ...(patch.source || {}) },
    web: { ...(current.web || {}), ...(patch.web || {}) },
    mac: { ...(current.mac || {}), ...(patch.mac || {}) },
    updatedAt: new Date().toISOString()
  }
  fm.writeString(file, JSON.stringify(next, null, 2))
  return next
}
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
  const root = fm.joinPath(fm.documentsDirectory(), 'Chapter Splitter')
  const inbox = fm.joinPath(root, 'inbox')
  const jobs = fm.joinPath(root, 'jobs')
  const results = fm.joinPath(root, 'results')
  const action = request.action || 'new-job'
  ensureDirectories(fm, inbox, jobs, results)

  if (action === 'new-job') {
    const localJobId = newJobId()
    const extension = extensionOf(request.extension)
    if (extension && !allowedExtensions.has(extension)) fail('只支持 PDF 或 EPUB。')
    writeJob(fm, jobs, localJobId, {
      state: 'created', message: '任务已创建，等待保存原文件。',
      source: { extension: extension || null, originalName: String(request.originalName || ''), storedFile: extension ? `inbox/${sourceFileName(localJobId, request.originalName, extension)}` : null }
    })
    return output(localJobId)
  }

  if (!validJobId(request.jobId)) fail('localJobId（jobId）无效。')
  const localJobId = request.jobId

  if (action === 'queue') {
    const extension = extensionOf(request.extension)
    if (!allowedExtensions.has(extension)) fail('只支持 PDF 或 EPUB。')
    const job = await readJob(fm, jobs, localJobId)
    const file = inputFile(fm, inbox, localJobId, job, extension)
    if (!fm.fileExists(file)) fail(`未找到输入文件：${localJobId}-<原文件名>.${extension}`)
    await fm.downloadFileFromiCloud(file)
    writeJob(fm, jobs, localJobId, {
      state: 'queued', message: '已由 iPhone 入队，等待 Mac。', source: { extension, storedFile: `inbox/${file.split('/').pop()}` },
      mac: { state: 'queued', message: '已由 iPhone 入队，等待 Mac。', updatedAt: new Date().toISOString() }
    })
    return output('queued')
  }

  if (action === 'web-submit') {
    const extension = extensionOf(request.extension)
    if (!allowedExtensions.has(extension)) fail('只支持 PDF 或 EPUB。')
    const job = await readJob(fm, jobs, localJobId)
    const file = inputFile(fm, inbox, localJobId, job, extension)
    if (!fm.fileExists(file)) fail(`未找到输入文件：${localJobId}-<原文件名>.${extension}`)
    await fm.downloadFileFromiCloud(file)
    const storedFile = `inbox/${file.split('/').pop()}`
    writeJob(fm, jobs, localJobId, { state: 'uploading', message: '正在上传到云端。', source: { extension, storedFile }, web: { state: 'uploading' } })
    const originalName = (job.source && job.source.originalName) || file.split('/').pop().slice(`${localJobId}-`.length)
    const webRequest = new Request(apiUrl(`/jobs?jobId=${encodeURIComponent(localJobId)}&extension=${extension}&originalName=${encodeURIComponent(originalName)}`))
    webRequest.timeoutInterval = 180
    webRequest.method = 'POST'
    webRequest.headers = { ...apiHeaders(), 'Content-Type': extension === 'pdf' ? 'application/pdf' : 'application/epub+zip' }
    webRequest.body = fm.read(file)
    const result = await apiJSON(webRequest)
    const webJobId = typeof result.jobId === 'string' ? result.jobId : null
    writeJob(fm, jobs, localJobId, {
      state: result.state || 'failed', message: result.message || '云端提交失败。',
      web: { jobId: webJobId, state: result.state || 'failed', message: result.message, resultUrl: result.resultUrl || null, errorCode: result.errorCode || null }
    })
    // 保持你现有快捷指令兼容：成功时仍输出 webJobId。
    return output(webJobId && result.state !== 'failed' ? webJobId : 'failed')
  }

  if (action === 'web-status') {
    const job = await readJob(fm, jobs, localJobId)
    const webJobId = job.web && job.web.jobId
    if (typeof webJobId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(webJobId)) fail('任务记录中没有有效的云端任务 ID。')
    const webRequest = new Request(apiUrl(`/jobs/${encodeURIComponent(webJobId)}`))
    webRequest.timeoutInterval = 60
    webRequest.headers = apiHeaders()
    const result = await apiJSON(webRequest)
    writeJob(fm, jobs, localJobId, {
      state: result.state || 'failed', message: result.message || '云端状态查询失败。',
      web: { state: result.state || 'failed', message: result.message, resultUrl: result.resultUrl || job.web.resultUrl || null, errorCode: result.errorCode || null, updatedAt: new Date().toISOString() }
    })
    return output(result.state || 'failed')
  }

  if (action === 'web-result-url') {
    const job = await readJob(fm, jobs, localJobId)
    const webJobId = job.web && job.web.jobId
    if (typeof webJobId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(webJobId)) fail('任务记录中没有有效的云端任务 ID。')
    const resultUrl = (job.web && job.web.resultUrl) || apiUrl(`/jobs/${encodeURIComponent(webJobId)}/result`)
    writeJob(fm, jobs, localJobId, { web: { resultUrl } })
    return output(resultUrl)
  }

  // 供快捷指令沿用“拼接 URL → 获取 URL 内容 → 解析 state”的流程时回写状态。
  if (action === 'record-web-state') {
    const state = String(request.state || '').trim()
    if (!state) fail('缺少云端状态。')
    writeJob(fm, jobs, localJobId, {
      state,
      message: String(request.message || `云端状态：${state}`),
      web: { state, ...(typeof request.resultUrl === 'string' ? { resultUrl: request.resultUrl } : {}) }
    })
    return output(state)
  }

  if (action === 'mark-result') {
    const job = await readJob(fm, jobs, localJobId)
    const fileName = String(request.fileName || resultFileName(localJobId, job.source && job.source.originalName))
    writeJob(fm, jobs, localJobId, { state: 'succeeded', message: '结果已保存到 iCloud Drive。', result: `results/${fileName}`, web: { state: 'succeeded' } })
    return output(`results/${fileName}`)
  }

  if (action === 'result-file-name') {
    const job = await readJob(fm, jobs, localJobId)
    return output(resultFileName(localJobId, job.source && job.source.originalName))
  }

  if (action === 'web-cancel') {
    const job = await readJob(fm, jobs, localJobId)
    const webJobId = job.web && job.web.jobId
    if (typeof webJobId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(webJobId)) fail('任务记录中没有有效的云端任务 ID。')
    const webRequest = new Request(apiUrl(`/jobs/${encodeURIComponent(webJobId)}`))
    webRequest.method = 'DELETE'; webRequest.headers = apiHeaders()
    const result = await apiJSON(webRequest)
    writeJob(fm, jobs, localJobId, { state: result.state || 'cancelled', message: result.message || '云端任务已取消。', web: { state: result.state || 'cancelled' } })
    return output(result.state || 'cancelled')
  }

  if (action === 'status') return output(JSON.stringify(await readJob(fm, jobs, localJobId)))
  fail('未知操作。')
}

await main()
