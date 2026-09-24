import Foundation
import PDFKit
struct Chapter: Encodable { let title: String; let start_page: Int; let end_page: Int; let page_label: String; let source: String; let confidence: String }
func fail(_ message: String) -> Never { FileHandle.standardError.write(Data(("Error: \(message)\n").utf8)); exit(1) }
func safeFilename(_ value: String) -> String { let cleaned = value.replacingOccurrences(of: "[\\\\/:*?\"<>|]", with: "-", options: .regularExpression).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines); return cleaned.isEmpty ? "Untitled chapter" : String(cleaned.prefix(100)) }
func outlineChapters(_ node: PDFOutline, document: PDFDocument, currentLevel: Int, requestedLevel: Int, result: inout [(String, Int)]) {
    for index in 0..<node.numberOfChildren { guard let child = node.child(at: index) else { continue }; let level = currentLevel + 1
        if level == requestedLevel, let page = child.destination?.page { let pageIndex = document.index(for: page); if pageIndex >= 0 { result.append((child.label ?? "Chapter \(result.count + 1)", pageIndex)) } }
        outlineChapters(child, document: document, currentLevel: level, requestedLevel: requestedLevel, result: &result)
    }
}
func inferredChapters(_ document: PDFDocument) -> [(String, Int)] {
    let expression = "^(第[〇零一二三四五六七八九十百千0-9]+[章节篇部卷]|chapter\\s+[0-9ivxlcdm]+\\b|part\\s+[0-9ivxlcdm]+\\b)"
    guard let regex = try? NSRegularExpression(pattern: expression, options: [.caseInsensitive]) else { return [] }; var result: [(String, Int)] = []
    for pageIndex in 0..<document.pageCount { guard let text = document.page(at: pageIndex)?.string else { continue }
        for rawLine in text.components(separatedBy: .newlines) { let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines), range = NSRange(line.startIndex..., in: line)
            guard regex.firstMatch(in: line, options: [], range: range) != nil, !line.contains("…"), !line.contains("...."), line.range(of: "\\.{2,}\\s*\\d+\\s*$", options: .regularExpression) == nil else { continue }; result.append((line, pageIndex)); break
        }
    }; return result
}
let arguments = CommandLine.arguments
guard arguments.count == 4 else { fail("usage: pdf-split.swift INPUT OUTPUT LEVEL") }
let input = URL(fileURLWithPath: arguments[1]), output = URL(fileURLWithPath: arguments[2], isDirectory: true)
guard let level = Int(arguments[3]), level > 0 else { fail("LEVEL must be a positive integer") }
guard let document = PDFDocument(url: input) else { fail("Cannot open PDF (it may be encrypted or malformed)") }; guard document.pageCount > 0 else { fail("PDF has no pages") }
var starts: [(String, Int)] = []; if let root = document.outlineRoot { outlineChapters(root, document: document, currentLevel: 0, requestedLevel: level, result: &starts) }
let source = starts.isEmpty ? "heading" : "outline"; if starts.isEmpty { starts = inferredChapters(document) }; guard !starts.isEmpty else { fail("No usable bookmarks or chapter headings found. Add bookmarks, or use a PDF whose chapter headings are text-selectable.") }
var unique: [(String, Int)] = []; for item in starts.sorted(by: { $0.1 < $1.1 }) { if unique.last?.1 != item.1 { unique.append(item) } }; guard !unique.isEmpty else { fail("No distinct chapter boundaries found") }
var chapters: [Chapter] = []
for index in 0..<unique.count { let (title, start) = unique[index], end = index + 1 < unique.count ? unique[index + 1].1 - 1 : document.pageCount - 1; guard end >= start else { continue }; let piece = PDFDocument()
    for pageIndex in start...end { if let page = document.page(at: pageIndex) { piece.insert(page, at: piece.pageCount) } }
    let filename = String(format: "%03d-%@.pdf", index + 1, safeFilename(title)); guard piece.write(to: output.appendingPathComponent(filename)) else { fail("Cannot write \(filename)") }; let label = document.page(at: start)?.label ?? String(start + 1); chapters.append(Chapter(title: title, start_page: start + 1, end_page: end + 1, page_label: label, source: source, confidence: source == "outline" ? "high" : "medium"))
}
let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]; guard let data = try? encoder.encode(chapters) else { fail("Cannot encode chapter manifest") }; FileHandle.standardOutput.write(data)
