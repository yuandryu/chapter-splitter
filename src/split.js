const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdtempSync } = require('fs');
const { basename, extname, join, resolve, posix } = require('path');
const { tmpdir } = require('os');
const { spawnSync } = require('child_process');

const USAGE = `
用法：
  chapter-split <PDF|EPUB> --out <输出目录> [--level <书签层级>]

PDF 优先按内置书签切分；没有书签时识别可提取正文中的“第 X 章 / Chapter X / Part X”。
EPUB 优先按 nav.xhtml 或 toc.ncx 切分；没有导航时按 OPF spine 中的内容文件切分。
每次都会生成 chapters.json，列出边界、识别来源与置信度。
`;
function die(message) { throw new Error(message); }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) die(`${command} 执行失败：${result.stderr || result.error?.message || ''}`.trim());
  return result.stdout;
}
function takeOption(args, name, required = false) {
  const index = args.indexOf(name);
  if (index < 0) { if (required) die(`缺少 ${name}`); return undefined; }
  if (!args[index + 1] || args[index + 1].startsWith('--')) die(`${name} 需要一个值`);
  return args.splice(index, 2)[1];
}
function safeName(value) { return (value || 'Untitled chapter').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Untitled chapter'; }
function decodeXml(value) { return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(); }
function attributes(fragment) { return Object.fromEntries([...fragment.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(([, key, , value]) => [key, value])); }
function normalized(base, href) { return posix.normalize(posix.join(posix.dirname(base), href.split('#')[0])).replace(/^\.\//, ''); }
function splitPdf(input, output, level) {
  const chapters = JSON.parse(run('swift', [join(__dirname, 'pdf-split.swift'), input, output, String(level)]));
  writeFileSync(join(output, 'chapters.json'), JSON.stringify({ format: 'pdf', input, chapters }, null, 2) + '\n');
  return chapters.length;
}
function epubNavigation(root, opfPath, opf, manifest, spine) {
  const nav = [...manifest.values()].find(item => /(^|\s)nav(\s|$)/.test(item.properties || ''));
  const tocId = (opf.match(/<spine\b[^>]*\btoc\s*=\s*(["'])(.*?)\1/i) || [])[2];
  const source = nav || (tocId ? manifest.get(tocId) : undefined);
  if (!source) return [];
  const sourcePath = normalized(opfPath, source.href);
  const text = readFileSync(join(root, sourcePath), 'utf8');
  const entries = [];
  if (nav) for (const match of text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) { const href = attributes(match[1]).href; if (href) entries.push({ title: decodeXml(match[2]), path: normalized(sourcePath, href) }); }
  else for (const match of text.matchAll(/<navPoint\b[\s\S]*?<navLabel\b[^>]*>\s*<text[^>]*>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*)\/?\s*>/gi)) { const href = attributes(match[2]).src; if (href) entries.push({ title: decodeXml(match[1]), path: normalized(sourcePath, href) }); }
  const byPath = new Map([...manifest.values()].map(item => [normalized(opfPath, item.href), item.id]));
  const spineIndex = new Map(spine.map((id, index) => [id, index]));
  return entries.map(entry => ({ ...entry, id: byPath.get(entry.path) })).filter(entry => spineIndex.has(entry.id)).map(entry => ({ ...entry, index: spineIndex.get(entry.id) }));
}
function splitEpub(input, output) {
  const stage = mkdtempSync(join(tmpdir(), 'chapter-split-'));
  try {
    run('unzip', ['-qq', input, '-d', stage]);
    const container = readFileSync(join(stage, 'META-INF', 'container.xml'), 'utf8');
    const opfRelative = (container.match(/<rootfile\b[^>]*\bfull-path\s*=\s*(["'])(.*?)\1/i) || [])[2];
    if (!opfRelative) die('EPUB 缺少 META-INF/container.xml 的 OPF 定位信息');
    const opfFile = join(stage, opfRelative), opf = readFileSync(opfFile, 'utf8'), manifest = new Map();
    for (const match of opf.matchAll(/<item\b([^>]*?)\/?\s*>/gi)) { const item = attributes(match[1]); if (item.id && item.href) manifest.set(item.id, item); }
    const spineMatch = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
    if (!spineMatch) die('EPUB 缺少 spine');
    const spine = [...spineMatch[1].matchAll(/<itemref\b([^>]*?)\/?\s*>/gi)].map(match => attributes(match[1]).idref).filter(Boolean);
    if (!spine.length) die('EPUB spine 不含可阅读内容');
    const navigation = epubNavigation(stage, opfRelative, opf, manifest, spine);
    const rawStarts = navigation.length ? navigation : spine.map((id, index) => ({ title: basename(manifest.get(id)?.href || `Chapter ${index + 1}`), id, index }));
    const starts = rawStarts.filter((entry, index, values) => index === 0 || entry.index !== values[index - 1].index), chapters = [];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index], end = index + 1 < starts.length ? starts[index + 1].index : spine.length, selected = spine.slice(start.index, end);
      if (!selected.length) continue;
      writeFileSync(opfFile, opf.replace(/(<spine\b[^>]*>)[\s\S]*?(<\/spine>)/i, `$1\n${selected.map(id => `    <itemref idref="${id}"/>`).join('\n')}\n  $2`));
      const filename = `${String(index + 1).padStart(3, '0')}-${safeName(start.title)}.epub`, target = resolve(output, filename);
      if (existsSync(join(stage, 'mimetype'))) run('zip', ['-X', '-q', '-0', target, 'mimetype'], { cwd: stage });
      run('zip', ['-X', '-q', '-r', target, '.', '-x', 'mimetype'], { cwd: stage });
      chapters.push({ title: start.title, start_spine_index: start.index + 1, end_spine_index: end, source: navigation.length ? 'navigation' : 'spine', confidence: navigation.length ? 'high' : 'medium', file: filename });
      writeFileSync(opfFile, opf);
    }
    writeFileSync(join(output, 'chapters.json'), JSON.stringify({ format: 'epub', input, chapters, note: 'Each output EPUB has a narrowed spine. Non-spine source resources are retained to preserve CSS, images, fonts and links.' }, null, 2) + '\n');
    return chapters.length;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
function runSplit(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') { console.log(USAGE); return; }
  const inputArg = args.shift(); if (inputArg.startsWith('--')) die('需要一个 PDF 或 EPUB 路径');
  const output = resolve(takeOption(args, '--out', true)), level = Number(takeOption(args, '--level') || '1');
  if (!Number.isInteger(level) || level < 1) die('--level 必须是正整数');
  if (args.length) die(`无法识别的参数：${args.join(' ')}`);
  const input = resolve(inputArg); if (!existsSync(input)) die(`找不到输入文件：${input}`);
  if (existsSync(output) && readdirSync(output).length) die(`输出目录必须为空：${output}`); mkdirSync(output, { recursive: true });
  const extension = extname(input).toLowerCase();
  const count = extension === '.pdf' ? splitPdf(input, output, level) : extension === '.epub' ? splitEpub(input, output) : die('只接受 .pdf 或 .epub 文件');
  console.log(`已输出 ${count} 个章节到：${output}`); console.log(`请先复核：${join(output, 'chapters.json')}`);
}
module.exports = { runSplit, USAGE };
