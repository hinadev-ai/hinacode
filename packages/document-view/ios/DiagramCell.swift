import UIKit

final class DiagramShapes {
  enum Shape {
    case path(CGPath, fill: UIColor?, stroke: UIColor?, width: CGFloat, dash: [CGFloat]?, opacity: CGFloat)
    case text(NSAttributedString, origin: CGPoint)
  }

  static let maxScale: CGFloat = 1.5
  static let minScale: CGFloat = 0.6

  let size: CGSize
  let shapes: [Shape]

  init(drawing: DiagramDrawing, style: DocumentStyle) {
    size = CGSize(width: drawing.width, height: drawing.height)
    shapes = drawing.shapes.compactMap { shape in
      switch shape {
      case .path(let data, let fill, let stroke, let width, let dash, let opacity):
        return .path(
          Self.path(data), fill: style.diagramPaint(fill), stroke: style.diagramPaint(stroke), width: CGFloat(width),
          dash: dash.map { $0.map { CGFloat($0) } }, opacity: CGFloat(opacity))
      case .text(let text, let x, let y, let anchor, let size, let weight, let fill):
        let font = UIFont.systemFont(ofSize: CGFloat(size), weight: weight >= 600 ? .bold : weight >= 500 ? .medium : .regular)
        let string = NSAttributedString(
          string: text, attributes: [.font: font, .foregroundColor: style.diagramPaint(fill) ?? style.diagramForeground])
        let width = string.size().width
        let left: CGFloat
        switch anchor {
        case "middle": left = CGFloat(x) - width / 2
        case "end": left = CGFloat(x) - width
        default: left = CGFloat(x)
        }
        return .text(string, origin: CGPoint(x: left, y: CGFloat(y) - font.ascender))
      }
    }
  }

  private static func path(_ data: [Double]) -> CGPath {
    let path = CGMutablePath()
    var index = 0
    func point(_ at: Int) -> CGPoint { CGPoint(x: data[at], y: data[at + 1]) }
    while index < data.count {
      let operands: Int
      switch DiagramPathOp(rawValue: Int(data[index])) {
      case .move: operands = 2
      case .line: operands = 2
      case .cubic: operands = 6
      case .close: operands = 0
      case nil: return path
      }
      guard index + operands < data.count else { return path }
      switch DiagramPathOp(rawValue: Int(data[index])) {
      case .move: path.move(to: point(index + 1))
      case .line: if path.isEmpty { path.move(to: point(index + 1)) } else { path.addLine(to: point(index + 1)) }
      case .cubic:
        if path.isEmpty { path.move(to: point(index + 5)) }
        path.addCurve(to: point(index + 5), control1: point(index + 1), control2: point(index + 3))
      case .close: if !path.isEmpty { path.closeSubpath() }
      case nil: return path
      }
      index += operands + 1
    }
    return path
  }

  func scale(width: CGFloat) -> CGFloat {
    max(Self.minScale, min(Self.maxScale, width / max(size.width, 1)))
  }
}

final class DiagramPainter: CanvasPainter {
  let size: CGSize
  private let shapes: DiagramShapes
  private let scale: CGFloat

  init(shapes: DiagramShapes, width: CGFloat) {
    self.shapes = shapes
    scale = shapes.scale(width: width)
    size = CGSize(width: ceil(shapes.size.width * scale), height: ceil(shapes.size.height * scale))
  }

  func paint(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    context.scaleBy(x: scale, y: scale)
    context.setLineJoin(.round)
    context.setLineCap(.round)
    for shape in shapes.shapes {
      switch shape {
      case .path(let path, let fill, let stroke, let width, let dash, let opacity):
        context.saveGState()
        context.setAlpha(opacity)
        if let fill {
          context.addPath(path)
          context.setFillColor(fill.cgColor)
          context.fillPath()
        }
        if let stroke, width > 0 {
          context.addPath(path)
          context.setStrokeColor(stroke.cgColor)
          context.setLineWidth(width)
          if let dash, !dash.isEmpty { context.setLineDash(phase: 0, lengths: dash) }
          context.strokePath()
        }
        context.restoreGState()
      case .text(let text, let origin):
        text.draw(at: origin)
      }
    }
  }
}

final class DiagramCell: BlockCell {
  private let scroller = UIScrollView()
  private let canvas = CanvasHost()
  private var shapes: DiagramShapes?
  private var painter: DiagramPainter?
  private var painterWidth: CGFloat = 0

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroller.showsVerticalScrollIndicator = false
    scroller.alwaysBounceVertical = false
    scroller.addSubview(canvas)
    contentView.addSubview(scroller)
  }

  required init?(coder: NSCoder) { nil }

  func configure(_ block: Block, placement: Placement, style: DocumentStyle, shapes: DiagramShapes) {
    super.configure(block, placement: placement, style: style)
    self.shapes = shapes
    painter = nil
  }

  private func painter(width: CGFloat) -> DiagramPainter? {
    guard let shapes else { return nil }
    if let painter, painterWidth == width { return painter }
    let next = DiagramPainter(shapes: shapes, width: width)
    painter = next
    painterWidth = width
    return next
  }

  override func contentHeight(width: CGFloat) -> CGFloat { painter(width: width)?.size.height ?? 0 }

  override func layoutContent(in frame: CGRect) {
    scroller.frame = frame
    guard let painter = painter(width: frame.width) else { return }
    if canvas.painter !== painter {
      canvas.show(painter)
      canvas.frame = CGRect(origin: .zero, size: painter.size)
      scroller.contentSize = painter.size
      scroller.contentOffset = .zero
    }
    canvas.frame.origin.x = max(0, (frame.width - painter.size.width) / 2)
  }
}
