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

  func text(_ cell: TableCellIndex) -> NSAttributedString? {
    guard cell.row < cells.count, cell.column < cells[cell.row].count else { return nil }
    return cells[cell.row][cell.column]
  }

  /// The text area of a cell, inside its padding, in the grid's coordinates.
  func textRect(_ cell: TableCellIndex) -> CGRect? {
    guard cell.row < cells.count, cell.column < columns.count else { return nil }
    let x = columns[..<cell.column].reduce(0, +)
    return CGRect(
      x: x + Self.padding.left, y: rowTops[cell.row] + Self.padding.top,
      width: columns[cell.column] - Self.padding.left - Self.padding.right,
      height: rowTops[cell.row + 1] - rowTops[cell.row] - Self.padding.top - Self.padding.bottom)
  }

  func cell(at point: CGPoint) -> TableCellIndex? {
    guard point.y >= 0, point.x >= 0, let row = rowTops.lastIndex(where: { $0 <= point.y }), row < cells.count else {
      return nil
    }
    var right: CGFloat = 0
    for (column, width) in columns.enumerated() {
      right += width
      if point.x < right { return TableCellIndex(row: row, column: column) }
    }
    return nil
  }

  func isHeader(_ cell: TableCellIndex) -> Bool { header && cell.row == 0 }

  /// The link under a point in the grid, laid out the way `paint` draws the cell's text.
  func href(at point: CGPoint) -> String? {
    guard let cell = cell(at: point), let rect = textRect(cell), let text = text(cell), text.length > 0 else { return nil }
    let storage = NSTextStorage(attributedString: text)
    let manager = NSLayoutManager()
    storage.addLayoutManager(manager)
    let container = NSTextContainer(size: CGSize(width: rect.width, height: .greatestFiniteMagnitude))
    container.lineFragmentPadding = 0
    manager.addTextContainer(container)
    let local = CGPoint(x: point.x - rect.minX, y: point.y - rect.minY)
    let glyph = manager.glyphIndex(for: local, in: container)
    let bounds = manager.boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
    guard bounds.insetBy(dx: -6, dy: -6).contains(local) else { return nil }
    return text.attribute(.documentHref, at: manager.characterIndexForGlyph(at: glyph), effectiveRange: nil) as? String
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

final class TableCell: BlockCell, UIScrollViewDelegate {
  private let scroller = UIScrollView()
  private let grid = CanvasHost()
  private(set) var table: TablePainter?
  var onScroll: () -> Void = {}
  private var onLink: (String) -> Void = { _ in }
  private let linkTap = UITapGestureRecognizer()

  override init(frame: CGRect) {
    super.init(frame: frame)
    linkTap.addTarget(self, action: #selector(tapped(_:)))
    scroller.addGestureRecognizer(linkTap)
    scroller.delegate = self
    scroller.showsVerticalScrollIndicator = false
    scroller.alwaysBounceVertical = false
    scroller.addSubview(grid)
    contentView.addSubview(scroller)
  }

  required init?(coder: NSCoder) { nil }

  /// `interactive` is false while the document is editable: a tap then focuses a cell instead of opening its link.
  func configure(
    _ block: Block, placement: Placement, style: DocumentStyle, table: TablePainter, interactive: Bool,
    onLink: @escaping (String) -> Void
  ) {
    super.configure(block, placement: placement, style: style)
    self.onLink = onLink
    linkTap.isEnabled = interactive
    self.table = table
    grid.show(table)
    grid.frame = CGRect(origin: .zero, size: table.size)
    scroller.contentSize = table.size
    scroller.contentOffset = .zero
  }

  override func contentHeight(width: CGFloat) -> CGFloat { table?.size.height ?? 0 }

  func scrollViewDidScroll(_ scrollView: UIScrollView) { onScroll() }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    if let href = table?.href(at: gesture.location(in: grid)) { onLink(href) }
  }

  private var gridOrigin: CGPoint {
    CGPoint(x: scroller.frame.minX - scroller.contentOffset.x, y: scroller.frame.minY - scroller.contentOffset.y)
  }

  func tableCell(at point: CGPoint) -> TableCellIndex? {
    guard scroller.frame.contains(point) else { return nil }
    return table?.cell(at: CGPoint(x: point.x - gridOrigin.x, y: point.y - gridOrigin.y))
  }

  override func editorFrame(cell: TableCellIndex?) -> CGRect? {
    guard let cell, let rect = table?.textRect(cell) else { return nil }
    return rect.offsetBy(dx: gridOrigin.x, dy: gridOrigin.y)
  }

  func reveal(_ cell: TableCellIndex) {
    guard let rect = table?.textRect(cell) else { return }
    scroller.scrollRectToVisible(rect.insetBy(dx: -12, dy: 0), animated: false)
  }

  override func layoutContent(in frame: CGRect) {
    scroller.frame = frame
  }
}
