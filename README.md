# chapter-splitter

独立的本地命令行工具：将 PDF 或 EPUB 按章节拆成多个文件，并在输出目录写入可人工复核的 `chapters.json`。

要求：macOS、Node.js 18+，以及系统自带的 `swift`、PDFKit、`zip`、`unzip`。无需 npm 依赖。

```bash
node bin/chapter-split "/path/to/book.pdf" --out "/path/to/book-chapters"
node bin/chapter-split "/path/to/book.epub" --out "/path/to/book-chapters"
node bin/chapter-split "/path/to/book.pdf" --out "/path/to/book-chapters" --level 2
```

PDF 优先读取书签，书签指向的是真实物理页，因此目录印刷页码和文件页码不一致不会造成偏移。没有书签时识别正文可提取文字中的 `第 X 章`、`Chapter X` 与 `Part X`，并标为中等置信度。无文字层的扫描 PDF 会报错而不会猜测。

EPUB 优先使用 EPUB 3 `nav.xhtml` 或 EPUB 2 `toc.ncx`；没有导航时按 OPF `spine` 切分。输出会保留图片、字体和 CSS，并将阅读顺序收窄到相应章节。

输出目录必须为空或不存在，避免覆盖已有文件。验证命令：`node --test test/*.test.js`。

## 快捷指令与云端主处理

快捷指令集成和 Scriptable 脚本位于 [`integrations/`](./integrations/)。云端 API 的 Render Free 部署文件与说明位于 [`cloud/`](./cloud/)。云端失败后会保留 iCloud `inbox` 中的原文件，并询问是否通过 SSH 切换到 Mac 后端。

## iPhone/iPad 快捷指令入口

已提供 Scriptable + iCloud Drive + SSH 到 Mac 的异步任务集成。手机从共享表单接收文件，Mac 完成切分并将 ZIP 结果同步回 iCloud Drive。安装步骤见 [integrations/SHORTCUTS.md](./integrations/SHORTCUTS.md)。
