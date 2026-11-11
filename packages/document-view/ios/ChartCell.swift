import UIKit

private let maxSeries = 6

final class ChartPainter: CanvasPainter {
  private static let plotHeight: CGFloat = 200
  private static let axisWidth: CGFloat = 52
  private static let xLabelHeight: CGFloat = 20
  private static let legendRowHeight: CGFloat = 20
  private static let gap: CGFloat = 8

  let size: CGSize
  private let chart: Chart
  private let style: DocumentStyle
  private let series: [ChartSeries]
  private let title: NSAttributedString?
  private let notes: NSAttributedString?
  private let titleHeight: CGFloat
  private let notesHeight: CGFloat
  private let legend: [(rect: CGRect, label: NSAttributedString, color: UIColor)]
  private let legendHeight: CGFloat
  private let low: Double
  private let high: Double
  private let labelFont = UIFont.systemFont(ofSize: 11)

  init(chart: Chart, width: CGFloat, style: DocumentStyle) {
    self.chart = chart
    self.style = style
    series = Array(chart.series.prefix(maxSeries))
    let values = series.flatMap { $0.values.compactMap { $0 } }.filter(\.isFinite)
    var low = values.min() ?? 0
    var high = values.max() ?? 1
    if !chart.isLine { low = min(low, 0); high = max(high, 0) }
    if low == high { high = low + 1 }
    self.low = low
    self.high = high

    title =
      chart.title.isEmpty
      ? nil
      : NSAttributedString(
        string: chart.title, attributes: [.font: UIFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: style.text])
    titleHeight = title.map { ceil($0.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, context: nil).height) + Self.gap } ?? 0
    notes =
      chart.notes.isEmpty
      ? nil : NSAttributedString(string: chart.notes, attributes: [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: style.muted])
    notesHeight = notes.map { Self.gap + ceil($0.boundingRect(with: CGSize(width: width, height: .greatestFiniteMagnitude), options: .usesLineFragmentOrigin, context: nil).height) } ?? 0

    var legend: [(CGRect, NSAttributedString, UIColor)] = []
    var x: CGFloat = 0
    var row: CGFloat = 0
    for (index, item) in series.enumerated() {
      let label = NSAttributedString(string: item.label, attributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: style.muted])
      let itemWidth = min(width, 14 + ceil(label.size().width))
      if x > 0, x + itemWidth > width { x = 0; row += 1 }
      legend.append((CGRect(x: x, y: row * Self.legendRowHeight, width: itemWidth, height: Self.legendRowHeight), label, style.chartLanes[index % style.chartLanes.count]))
      x += itemWidth + 14
    }
    self.legend = legend
    legendHeight = series.isEmpty ? 0 : Self.gap + (row + 1) * Self.legendRowHeight
    size = CGSize(width: width, height: titleHeight + Self.plotHeight + Self.xLabelHeight + legendHeight + notesHeight)
  }

  private func format(_ value: Double) -> String {
    let magnitude = abs(value)
    let number: String
    if magnitude >= 1_000_000 { number = String(format: "%.1fM", value / 1_000_000) }
    else if magnitude >= 10_000 { number = String(format: "%.1fk", value / 1_000) }
    else if value == value.rounded() { number = String(format: "%.0f", value) }
    else { number = String(format: "%.2f", value) }
    return chart.prefix + number + chart.suffix
  }

  func paint(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    title?.draw(with: CGRect(x: 0, y: 0, width: size.width, height: titleHeight), options: .usesLineFragmentOrigin, context: nil)
    let plot = CGRect(x: Self.axisWidth, y: titleHeight + 6, width: size.width - Self.axisWidth, height: Self.plotHeight - 12)
    let labelAttributes: [NSAttributedString.Key: Any] = [.font: labelFont, .foregroundColor: style.muted]

    for (value, y) in [(high, plot.minY), (low, plot.maxY)] {
      let label = NSAttributedString(string: format(value), attributes: labelAttributes)
      let labelSize = label.size()
      label.draw(at: CGPoint(x: Self.axisWidth - 6 - labelSize.width, y: y - labelSize.height / 2))
    }
    context.setFillColor(style.border.cgColor)
    context.fill(CGRect(x: plot.minX, y: plot.maxY - 0.5, width: plot.width, height: 1))
    context.fill(CGRect(x: plot.minX, y: plot.minY - 0.5, width: plot.width, height: 0.5))
    if low < 0, high > 0 { context.fill(CGRect(x: plot.minX, y: y(0, plot) - 0.25, width: plot.width, height: 0.5)) }

    let count = chart.x.count
    if count > 0 {
      let slot = plot.width / CGFloat(count)
      drawXLabels(plot: plot, slot: slot, attributes: labelAttributes)
      if chart.isLine { drawLines(context, plot: plot, slot: slot) } else { drawBars(context, plot: plot, slot: slot) }
    }

    let legendTop = plot.maxY + 6 + Self.xLabelHeight + Self.gap
    for item in legend {
      let swatch = CGRect(x: item.rect.minX, y: legendTop + item.rect.midY - 4, width: 8, height: 8)
      context.setFillColor(item.color.cgColor)
      context.addPath(UIBezierPath(roundedRect: swatch, cornerRadius: 2).cgPath)
      context.fillPath()
      let labelSize = item.label.size()
      item.label.draw(
        with: CGRect(x: item.rect.minX + 14, y: legendTop + item.rect.midY - labelSize.height / 2, width: item.rect.width - 14, height: labelSize.height),
        options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
    }
    notes?.draw(
      with: CGRect(x: 0, y: size.height - notesHeight + Self.gap, width: size.width, height: notesHeight),
      options: .usesLineFragmentOrigin, context: nil)
  }

  private func y(_ value: Double, _ plot: CGRect) -> CGFloat {
    plot.maxY - CGFloat((value - low) / (high - low)) * plot.height
  }

  private func drawXLabels(plot: CGRect, slot: CGFloat, attributes: [NSAttributedString.Key: Any]) {
    let widest = chart.x.prefix(200).reduce(CGFloat(0)) { max($0, NSAttributedString(string: $1, attributes: attributes).size().width) }
    let step = max(1, Int(ceil((min(widest, 90) + 10) / max(slot, 0.001))))
    for index in stride(from: 0, to: chart.x.count, by: step) {
      let label = NSAttributedString(string: chart.x[index], attributes: attributes)
      let width = min(label.size().width, slot * CGFloat(step) - 4)
      let center = plot.minX + slot * (CGFloat(index) + 0.5)
      let x = min(max(center - width / 2, plot.minX), plot.maxX - width)
      label.draw(
        with: CGRect(x: x, y: plot.maxY + 6, width: width, height: 16), options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine],
        context: nil)
    }
  }

  private func drawLines(_ context: CGContext, plot: CGRect, slot: CGFloat) {
    context.setLineWidth(2)
    context.setLineJoin(.round)
    context.setLineCap(.round)
    let values = series.map { Array($0.values.prefix(chart.x.count)) }
    let dotted = chart.x.count <= 30
    for (index, values) in values.enumerated() {
      let path = CGMutablePath()
      var dots: [CGPoint] = []
      var drawing = false
      for (column, value) in values.enumerated() {
        guard let value, value.isFinite else { drawing = false; continue }
        let point = CGPoint(x: plot.minX + slot * (CGFloat(column) + 0.5), y: y(value, plot))
        let isolated = !drawing && (column + 1 >= values.count || values[column + 1].map { !$0.isFinite } ?? true)
        if dotted || isolated { dots.append(point) }
        if drawing { path.addLine(to: point) } else { path.move(to: point); drawing = true }
      }
      let color = style.chartLanes[index % style.chartLanes.count].cgColor
      context.setStrokeColor(color)
      context.addPath(path)
      context.strokePath()
      context.setFillColor(color)
      for dot in dots { context.fillEllipse(in: CGRect(x: dot.x - 2.5, y: dot.y - 2.5, width: 5, height: 5)) }
    }
  }

  private func drawBars(_ context: CGContext, plot: CGRect, slot: CGFloat) {
    let groups = CGFloat(max(series.count, 1))
    let inner = slot * (slot > 6 ? 0.8 : 1)
    let barWidth = inner / groups
    let zero = y(max(low, min(high, 0)), plot)
    for (index, item) in series.enumerated() {
      context.setFillColor(style.chartLanes[index % style.chartLanes.count].cgColor)
      for (column, value) in item.values.prefix(chart.x.count).enumerated() {
        guard let value, value.isFinite else { continue }
        let x = plot.minX + slot * CGFloat(column) + (slot - inner) / 2 + barWidth * CGFloat(index)
        let top = y(value, plot)
        let bar = CGRect(x: x, y: min(top, zero), width: max(barWidth - (barWidth > 4 ? 1 : 0), 0.5), height: max(abs(zero - top), 0.5))
        context.fill(bar)
      }
    }
  }
}

final class ChartCell: BlockCell {
  private let canvas = CanvasHost()
  private var chart: Chart?
  private var painter: ChartPainter?
  private var painterWidth: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(canvas)
  }

  required init?(coder: NSCoder) { nil }

  func configure(_ block: Block, placement: Placement, style: DocumentStyle, chart: Chart) {
    super.configure(block, placement: placement, style: style)
    self.chart = chart
    painter = nil
  }

  private func painter(width: CGFloat) -> ChartPainter? {
    guard let chart else { return nil }
    if let painter, painterWidth == width { return painter }
    let next = ChartPainter(chart: chart, width: width, style: style)
    painter = next
    painterWidth = width
    return next
  }

  override func contentHeight(width: CGFloat) -> CGFloat { painter(width: width)?.size.height ?? 0 }

  override func layoutContent(in frame: CGRect) {
    canvas.frame = frame
    guard let painter = painter(width: frame.width) else { return }
    if canvas.painter !== painter { canvas.show(painter) }
  }
}
