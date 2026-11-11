import Foundation

struct Run: Equatable {
  let text: String
  let marks: Marks
  let href: String?
  let image: String?
  let alt: String?
}

enum Container: Equatable {
  case bullet(first: Bool)
  case ordered(number: Int, first: Bool)
  case task(checked: Bool, first: Bool)
  case quote(first: Bool, last: Bool)
  case callout(tone: String, first: Bool, last: Bool)

  var kind: ContainerKind {
    switch self {
    case .bullet: return .bullet
    case .ordered: return .ordered
    case .task: return .task
    case .quote: return .quote
    case .callout: return .callout
    }
  }

  var isListItem: Bool { kind == .bullet || kind == .ordered || kind == .task }
}

struct CodeToken: Equatable {
  let start: Int
  let end: Int
  let color: String
}

struct ChartSeries: Equatable {
  let label: String
  let values: [Double?]
}

struct Chart: Equatable {
  let source: String
  let isLine: Bool
  let title: String
  let notes: String
  let x: [String]
  let series: [ChartSeries]
  let prefix: String
  let suffix: String
}

enum DiagramShape: Equatable {
  case path(data: [Double], fill: String?, stroke: String?, width: Double, dash: [Double]?, opacity: Double)
  case text(text: String, x: Double, y: Double, anchor: String, size: Double, weight: Double, fill: String?)
}

struct DiagramDrawing: Equatable {
  let width: Double
  let height: Double
  let shapes: [DiagramShape]
}

enum TableAlign: String {
  case left, center, right
}

struct Table: Equatable {
  let align: [TableAlign?]
  let header: Bool
  let rows: [[[Run]]]
}

enum Body: Equatable {
  case paragraph(runs: [Run])
  case heading(level: Int, runs: [Run])
  case code(language: String, text: String, tokens: [CodeToken], error: String?)
  case chart(Chart)
  case diagram(source: String, drawing: DiagramDrawing?)
  case table(Table)
  case image(src: String, alt: String)
  case rule
  case unsupported(source: String)
}

struct Block: Equatable {
  let id: String
  let containers: [Container]
  let body: Body

  var isRightToLeft: Bool {
    switch body {
    case .paragraph(let runs), .heading(_, let runs):
      for run in runs {
        for scalar in run.text.unicodeScalars where scalar.properties.isAlphabetic {
          return Self.rightToLeftScalars.contains(where: { $0.contains(scalar.value) })
        }
      }
      return false
    default:
      return false
    }
  }

  var isTextBlock: Bool {
    switch body {
    case .paragraph, .heading: return true
    default: return false
    }
  }

  /// Blocks whose text the editor edits as source: code, and charts and diagrams while focused.
  var isSource: Bool {
    switch body {
    case .code, .chart, .diagram: return true
    default: return false
    }
  }

  /// The text the model counts offsets in, or nil when the block (or the cell) cannot be edited as text.
  func editableText(cell: TableCellIndex?) -> String? {
    switch body {
    case .paragraph(let runs), .heading(_, let runs): return runs.map(\.text).joined()
    case .code(_, let text, _, _): return text
    case .chart(let chart): return chart.source
    case .diagram(let source, _): return source
    case .table(let table):
      guard let cell, cell.row < table.rows.count, cell.column < table.rows[cell.row].count else { return nil }
      return table.rows[cell.row][cell.column].map(\.text).joined()
    case .image, .rule, .unsupported: return nil
    }
  }

  private static let rightToLeftScalars: [ClosedRange<UInt32>] = [
    0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF, 0x10800...0x10FFF, 0x1E800...0x1EFFF,
  ]
}

/// A caret end in the model's terms: a block index, the table cell for a table, and a UTF-16 offset into the text.
struct TextPoint: Equatable {
  let block: Int
  let cell: TableCellIndex?
  let offset: Int

  var payload: [String: Any] {
    ["block": block, "cell": cell.map { [$0.row, $0.column] as Any } ?? NSNull(), "offset": offset]
  }
}

struct TableCellIndex: Equatable {
  let row: Int
  let column: Int
}

struct BlockPatch {
  let eventCount: Int
  let start: Int
  let deleteCount: Int
  let insert: [Block]
  let selection: (anchor: TextPoint, head: TextPoint)?
}

enum PatchError: Error, CustomStringConvertible {
  case malformed(String)

  var description: String {
    switch self {
    case .malformed(let reason): return "Malformed block patch: \(reason)"
    }
  }
}

enum BlockDecoder {
  static func patch(_ json: String) throws -> BlockPatch {
    guard
      let data = json.data(using: .utf8),
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let start = object["start"] as? Int,
      let deleteCount = object["deleteCount"] as? Int,
      let insert = object["insert"] as? [[String: Any]]
    else { throw PatchError.malformed("expected {start, deleteCount, insert}") }
    let selection = object["selection"] as? [String: Any]
    let anchor = point(selection?["anchor"])
    let head = point(selection?["head"])
    return BlockPatch(
      eventCount: object["eventCount"] as? Int ?? 0, start: start, deleteCount: deleteCount,
      insert: insert.enumerated().map { block($0.element, at: $0.offset) },
      selection: anchor.flatMap { anchor in head.map { (anchor, $0) } })
  }

  private static func point(_ value: Any?) -> TextPoint? {
    guard let object = value as? [String: Any], let block = object["block"] as? Int, let offset = object["offset"] as? Int
    else { return nil }
    let cell = (object["cell"] as? [Int]).flatMap { $0.count == 2 ? TableCellIndex(row: $0[0], column: $0[1]) : nil }
    return TextPoint(block: block, cell: cell, offset: offset)
  }

  static func block(_ object: [String: Any], at index: Int) -> Block {
    let id = object["id"] as? String ?? "missing-\(index)"
    let containers = (object["containers"] as? [[String: Any]] ?? []).compactMap(container)
    return Block(id: id, containers: containers, body: body(object))
  }

  private static func container(_ object: [String: Any]) -> Container? {
    let first = object["first"] as? Bool ?? true
    switch (object["kind"] as? String).flatMap(ContainerKind.init(rawValue:)) {
    case .bullet: return .bullet(first: first)
    case .ordered: return .ordered(number: object["number"] as? Int ?? 1, first: first)
    case .task: return .task(checked: object["checked"] as? Bool ?? false, first: first)
    case .quote: return .quote(first: first, last: object["last"] as? Bool ?? true)
    case .callout:
      return .callout(tone: object["tone"] as? String ?? "note", first: first, last: object["last"] as? Bool ?? false)
    case nil: return nil
    }
  }

  private static func body(_ object: [String: Any]) -> Body {
    switch (object["kind"] as? String).flatMap(BlockKind.init(rawValue:)) {
    case .paragraph: return .paragraph(runs: runs(object["runs"]))
    case .heading: return .heading(level: object["level"] as? Int ?? 1, runs: runs(object["runs"]))
    case .code:
      return .code(
        language: object["language"] as? String ?? "", text: object["text"] as? String ?? "",
        tokens: tokens(object["tokens"]), error: object["error"] as? String)
    case .chart: return chart(object).map(Body.chart) ?? unsupported(object)
    case .diagram:
      return .diagram(source: object["source"] as? String ?? "", drawing: drawing(object["drawing"]))
    case .table:
      return .table(
        Table(
          align: (object["align"] as? [Any] ?? []).map { ($0 as? String).flatMap(TableAlign.init(rawValue:)) },
          header: object["header"] as? Bool ?? false,
          rows: (object["rows"] as? [[Any]] ?? []).map { $0.map(runs) }))
    case .image: return .image(src: object["src"] as? String ?? "", alt: object["alt"] as? String ?? "")
    case .rule: return .rule
    case .unsupported, nil: return unsupported(object)
    }
  }

  private static func unsupported(_ object: [String: Any]) -> Body {
    if let source = object["source"] as? String { return .unsupported(source: source) }
    if let text = object["text"] as? String { return .unsupported(source: text) }
    return .unsupported(source: runs(object["runs"]).map(\.text).joined())
  }

  private static func runs(_ value: Any?) -> [Run] {
    (value as? [[String: Any]] ?? []).map {
      Run(
        text: $0["text"] as? String ?? "", marks: Marks(rawValue: $0["marks"] as? Int ?? 0),
        href: $0["href"] as? String, image: $0["image"] as? String, alt: $0["alt"] as? String)
    }
  }

  private static func tokens(_ value: Any?) -> [CodeToken] {
    (value as? [[Any]] ?? []).compactMap { token in
      guard token.count == 3, let start = token[0] as? Int, let end = token[1] as? Int, let color = token[2] as? String
      else { return nil }
      return CodeToken(start: start, end: end, color: color)
    }
  }

  private static func numbers(_ value: Any?) -> [Double]? {
    (value as? [Any])?.compactMap { ($0 as? NSNumber)?.doubleValue }
  }

  private static func drawing(_ value: Any?) -> DiagramDrawing? {
    guard let object = value as? [String: Any], let width = (object["width"] as? NSNumber)?.doubleValue,
      let height = (object["height"] as? NSNumber)?.doubleValue, width > 0, height > 0
    else { return nil }
    let shapes = (object["shapes"] as? [[String: Any]] ?? []).compactMap { shape -> DiagramShape? in
      let number = { (key: String, fallback: Double) in (shape[key] as? NSNumber)?.doubleValue ?? fallback }
      switch shape["kind"] as? String {
      case "path":
        return .path(
          data: numbers(shape["data"]) ?? [], fill: shape["fill"] as? String, stroke: shape["stroke"] as? String,
          width: number("width", 1), dash: numbers(shape["dash"]), opacity: number("opacity", 1))
      case "text":
        return .text(
          text: shape["text"] as? String ?? "", x: number("x", 0), y: number("y", 0),
          anchor: shape["anchor"] as? String ?? "start", size: number("size", 14), weight: number("weight", 400),
          fill: shape["fill"] as? String)
      default:
        return nil
      }
    }
    return DiagramDrawing(width: width, height: height, shapes: shapes)
  }

  private static func chart(_ object: [String: Any]) -> Chart? {
    guard let x = object["x"] as? [Any], let series = object["series"] as? [[String: Any]] else { return nil }
    return Chart(
      source: object["source"] as? String ?? "",
      isLine: object["type"] as? String == "line",
      title: object["title"] as? String ?? "",
      notes: object["notes"] as? String ?? "",
      x: x.map { $0 as? String ?? "\($0)" },
      series: series.map { item in
        ChartSeries(
          label: item["label"] as? String ?? "",
          values: (item["values"] as? [Any] ?? []).map { ($0 as? NSNumber)?.doubleValue })
      },
      prefix: object["prefix"] as? String ?? "",
      suffix: object["suffix"] as? String ?? "")
  }
}
