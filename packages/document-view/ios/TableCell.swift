import UIKit

final class TablePainter: CanvasPainter {
  private static let padding = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
  private static let minColumn: CGFloat = 56
  private static let maxColumn: CGFloat = 260

  let size: CGSize
  private let cells: [[NSAttributedString]]
  private let columns: [CGFloat]
  private let rowTops: [CGFloat]
  private let header: Bool
  private let style: DocumentStyle

  init(table: Table, style: DocumentStyle) {
    self.style = style
    header = table.header
    let columnCount = table.rows.map(\.count).max() ?? 0
    let cells = table.rows.enumerated().map { rowIndex, row in
      (0..<columnCount).map { column -> NSAttributedString in
        let runs = column < row.count ? row[column] : []
        let alignment: NSTextAlignment
        switch column < table.align.count ? table.align[column] : nil {
        case .center: alignment = .center
        case .right: alignment = .right
        case .left, nil: alignment = .natural
        }
        let text = NSMutableAttributedString(
          attributedString: style.text(
            runs, size: style.fontSize - 1, lineHeight: style.lineHeight - 3,
            weight: table.header && rowIndex == 0 ? .semibold : .regular, alignment: alignment))
        text.removeAttribute(.link, range: NSRange(location: 0, length: text.length))
        return text
      }
    }
    let horizontal = Self.padding.left + Self.padding.right
    let unbounded = CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)
    let columns = (0..<columnCount).map { column in
      let widest = cells.reduce(CGFloat(0)) {
        max($0, ceil($1[column].boundingRect(with: unbounded, options: .usesLineFragmentOrigin, context: nil).width))
      }
      return min(max(widest + horizontal, Self.minColumn), Self.maxColumn)
    }
    var rowTops: [CGFloat] = [0]
    for row in cells {
      let height = zip(row, columns).reduce(style.lineHeight - 3) { tallest, cell in
        let bounds = CGSize(width: cell.1 - horizontal, height: .greatestFiniteMagnitude)
        return max(tallest, ceil(cell.0.boundingRect(with: bounds, options: .usesLineFragmentOrigin, context: nil).height))
      }
      rowTops.append(rowTops.last! + height + Self.padding.top + Self.padding.bottom)
    }
    self.cells = cells
    self.columns = columns
    self.rowTops = rowTops
    size = CGSize(width: columns.reduce(0, +) + 1, height: rowTops.last! + 1)
  }

  func paint(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext(), !cells.isEmpty else { return }
    if header {
      context.setFillColor(style.surface.cgColor)
      context.fill(CGRect(x: 0, y: 0, width: size.width, height: rowTops[1]))
    }
    let firstRow = max(0, (rowTops.firstIndex { $0 > rect.minY } ?? 1) - 1)
    let lastRow = min(cells.count - 1, rowTops.firstIndex { $0 >= rect.maxY } ?? cells.count - 1)
    guard firstRow <= lastRow else { return }
    let horizontal = Self.padding.left + Self.padding.right
    for row in firstRow...lastRow {
      var x: CGFloat = 0
      for (column, width) in columns.enumerated() {
        let cell = CGRect(x: x, y: rowTops[row], width: width, height: rowTops[row + 1] - rowTops[row])
        if cell.intersects(rect) {
          cells[row][column].draw(
            with: CGRect(
              x: cell.minX + Self.padding.left, y: cell.minY + Self.padding.top, width: width - horizontal,
              height: cell.height - Self.padding.top - Self.padding.bottom),
            options: .usesLineFragmentOrigin, context: nil)
        }
        x += width
      }
    }
    context.setFillColor(style.border.cgColor)
    let hairline = 1 / max(context.ctm.a, 1)
    for row in firstRow...(lastRow + 1) { context.fill(CGRect(x: 0, y: rowTops[row], width: size.width, height: hairline)) }
    var x: CGFloat = 0
    for width in [0] + columns {
      x += width
      context.fill(CGRect(x: min(x, size.width - hairline), y: rect.minY, width: hairline, height: min(rect.height, size.height - rect.minY)))
    }
  }
}

final class TableCell: BlockCell {
  private let scroller = UIScrollView()
  private let grid = CanvasHost()
  private var table: TablePainter?

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroller.showsVerticalScrollIndicator = false
    scroller.alwaysBounceVertical = false
    scroller.addSubview(grid)
    contentView.addSubview(scroller)
  }

  required init?(coder: NSCoder) { nil }

  func configure(_ block: Block, placement: Placement, style: DocumentStyle, table: TablePainter) {
    super.configure(block, placement: placement, style: style)
    self.table = table
    grid.show(table)
    grid.frame = CGRect(origin: .zero, size: table.size)
    scroller.contentSize = table.size
    scroller.contentOffset = .zero
  }

  override func contentHeight(width: CGFloat) -> CGFloat { table?.size.height ?? 0 }

  override func layoutContent(in frame: CGRect) {
    scroller.frame = frame
  }
}
