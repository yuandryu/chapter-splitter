const $ = (selector) => document.querySelector(selector)
const fileInput = $('#file'), uploadButton = $('#upload'), statusText = $('#status')
const chapterList = $('#chapter-list'), template = $('#chapter-row')
let selectedFile, job, pollTimer

function status(message) { statusText.textContent = message || '' }
$('#api-token').value = localStorage.getItem('chapter-splitter-api-token') || ''
$('#api-token').onchange = () => localStorage.setItem('chapter-splitter-api-token', $('#api-token').value.trim())
function request(path, options = {}) {
  const token = $('#api-token').value.trim()
  return fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } })
    .then(async response => { const value = await response.json(); if (!response.ok) throw new Error(value.message || '请求失败。'); return value })
}
function addChapter(value = {}) {
  const row = template.content.firstElementChild.cloneNode(true)
  row.querySelector('.chapter-title').value = value.title || ''
  row.querySelector('.chapter-page').value = value.startPage || ''
  row.querySelector('.remove').onclick = () => row.remove()
  chapterList.append(row)
}
function chapterValues() {
  return [...chapterList.querySelectorAll('.chapter-row')].map(row => ({ title: row.querySelector('.chapter-title').value, startPage: Number(row.querySelector('.chapter-page').value) }))
}
function showJob(next) {
  job = next
  $('#result-card').hidden = false
  $('#job-status').textContent = next.message || `状态：${next.state}`
  const download = $('#download')
  if (next.state === 'succeeded') {
    download.hidden = false
    request(`/jobs/${next.jobId}/result-url`).then(value => { download.href = value.url }).catch(error => status(error.message))
    clearInterval(pollTimer)
  }
  if (next.state === 'failed' || next.state === 'cancelled') clearInterval(pollTimer)
}
function showChapters(next) {
  const card = $('#chapters-card'); card.hidden = false
  $('#analysis-message').textContent = next.message
  const analysis = next.analysis || {}
  $('#page-count').textContent = analysis.pageCount ? `PDF 共 ${analysis.pageCount} 个实际页面。目录印刷页码不可用于此处。` : 'EPUB 将按导航目录自动切分。'
  chapterList.replaceChildren()
  if (next.extension === 'pdf') (next.chapters || []).forEach(addChapter)
  $('#add-chapter').hidden = next.extension !== 'pdf'
  $('#save-chapters').hidden = next.extension !== 'pdf'
}

fileInput.onchange = () => {
  selectedFile = fileInput.files[0]
  const extension = selectedFile?.name.split('.').pop().toLowerCase()
  uploadButton.disabled = !selectedFile || !['pdf', 'epub'].includes(extension)
  $('#file-name').textContent = selectedFile ? `${selectedFile.name}（${(selectedFile.size / 1024 / 1024).toFixed(1)} MB）` : '尚未选择文件'
}

uploadButton.onclick = async () => {
  try {
    const extension = selectedFile.name.split('.').pop().toLowerCase()
    uploadButton.disabled = true; status('正在创建上传任务…')
    const created = await request('/jobs', { method: 'POST', body: JSON.stringify({ originalName: selectedFile.name, extension, size: selectedFile.size }) })
    const parts = []
    $('#progress').hidden = false
    for (let index = 0; index < created.uploadUrls.length; index++) {
      const start = index * created.partSize, end = Math.min(start + created.partSize, selectedFile.size)
      status(`正在上传第 ${index + 1}/${created.uploadUrls.length} 部分…`)
      const response = await fetch(created.uploadUrls[index], { method: 'PUT', body: selectedFile.slice(start, end) })
      if (!response.ok) throw new Error(`第 ${index + 1} 部分上传失败。`)
      const etag = response.headers.get('ETag')
      if (!etag) throw new Error('存储服务未公开 ETag。请按部署说明设置 R2 CORS。')
      parts.push({ partNumber: index + 1, etag })
      $('#progress').value = Math.round((index + 1) / created.uploadUrls.length * 100)
    }
    status('上传完成，正在分析目录…')
    const completed = await request(`/jobs/${created.jobId}/upload-complete`, { method: 'POST', body: JSON.stringify({ parts }) })
    showJob(completed); showChapters(completed); status('')
  } catch (error) { status(error.message); uploadButton.disabled = false }
}

$('#add-chapter').onclick = () => addChapter()
$('#save-chapters').onclick = async () => { try { showJob(await request(`/jobs/${job.jobId}/chapters`, { method: 'PUT', body: JSON.stringify({ chapters: chapterValues() }) })) } catch (error) { status(error.message) } }
$('#process').onclick = async () => {
  try {
    if (job.extension === 'pdf') job = await request(`/jobs/${job.jobId}/chapters`, { method: 'PUT', body: JSON.stringify({ chapters: chapterValues() }) })
    showJob(await request(`/jobs/${job.jobId}/process`, { method: 'POST', body: '{}' }))
    pollTimer = setInterval(async () => { try { showJob(await request(`/jobs/${job.jobId}`)) } catch (error) { status(error.message) } }, 3000)
  } catch (error) { status(error.message) }
}
