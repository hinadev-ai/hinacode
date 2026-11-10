import UIKit

struct Placement: Equatable {
  var topSpacing: CGFloat = 0

  static func between(_ previous: Block?, _ block: Block) -> Placement {
    guard let previous else { return Placement() }
    let topSpacing: CGFloat
    if case .heading = block.body {
      topSpacing = DocumentStyle.headingSpacing
    } else if block.containers.contains(where: \.isListItem), previous.containers.contains(where: \.isListItem),
      previous.containers.first?.kind == block.containers.first?.kind
    {
      topSpacing = DocumentStyle.listSpacing
    } else {
      topSpacing = DocumentStyle.blockSpacing
    }
    return Placement(topSpacing: topSpacing)
  }
}

struct BlockGeometry {
  enum Mark {
    case bullet(x: CGFloat, level: Int)
    case number(x: CGFloat, text: String)
    case checkbox(x: CGFloat, checked: Bool)
    case quoteBar(x: CGFloat, top: CGFloat, bottomInset: CGFloat)
    case band(x: CGFloat, right: CGFloat, top: CGFloat, first: Bool, last: Bool, tone: String)
  }

  var content: CGRect = .zero
  var height: CGFloat = 0
  var marks: [Mark] = []
  var rightToLeft = false

  static func make(
    containers: [Container], placement: Placement, width: CGFloat, rightToLeft: Bool,
    contentHeight: (CGFloat) -> CGFloat
  ) -> BlockGeometry {
    let side = max(DocumentStyle.sidePadding, (width - DocumentStyle.readableWidth) / 2)
    var left = side
    var right = width - side
    var top = placement.topSpacing
    var bottom: CGFloat = 0
    var marks: [Mark] = []
    var listLevel = 0
    for container in containers {
      switch container {
      case .bullet(let first):
        if first { marks.append(.bullet(x: left, level: listLevel)) }
        listLevel += 1
        left += DocumentStyle.indent
      case .ordered(let number, let first):
        if first { marks.append(.number(x: left, text: "\(number).")) }
        listLevel += 1
        left += DocumentStyle.indent
      case .task(let checked, let first):
        if first { marks.append(.checkbox(x: left, checked: checked)) }
        listLevel += 1
        left += DocumentStyle.indent + 6
      case .quote(let first, let last):
        marks.append(.quoteBar(x: left, top: first ? top : 0, bottomInset: last ? DocumentStyle.quoteSpacing : 0))
        if last { bottom += DocumentStyle.quoteSpacing }
        left += DocumentStyle.indent - 4
      case .callout(let tone, let first, let last):
        marks.append(.band(x: left, right: right, top: first ? top : 0, first: first, last: last, tone: tone))
        if first { top += DocumentStyle.calloutPadding + DocumentStyle.calloutLabelHeight }
        if last { bottom += DocumentStyle.calloutPadding }
        left += DocumentStyle.calloutPadding + 2
        right -= DocumentStyle.calloutPadding + 2
      }
    }
    let contentWidth = max(1, right - left)
    let height = contentHeight(contentWidth)
    let content = CGRect(x: rightToLeft ? width - right : left, y: top, width: contentWidth, height: height)
    return BlockGeometry(content: content, height: ceil(top + height + bottom), marks: marks, rightToLeft: rightToLeft)
  }
}

class BlockCell: UICollectionViewCell {
  private(set) var style = DocumentStyle()
  private(set) var containers: [Container] = []
  private(set) var placement = Placement()
  private var rightToLeft = false
  private let decoration = DecorationView()
  private var measured: (width: CGFloat, geometry: BlockGeometry)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    decoration.isOpaque = false
    decoration.isUserInteractionEnabled = false
    contentView.addSubview(decoration)
  }

  required init?(coder: NSCoder) { nil }

  func configure(_ block: Block, placement: Placement, style: DocumentStyle) {
    self.style = style
    self.containers = block.containers
    self.placement = placement
    rightToLeft = block.isRightToLeft
    decoration.isHidden = block.containers.isEmpty
    invalidateMeasure()
  }

  func invalidateMeasure() {
    measured = nil
    setNeedsLayout()
  }

  func contentHeight(width: CGFloat) -> CGFloat { 0 }

  func layoutContent(in frame: CGRect) {}

  private func geometry(width: CGFloat) -> BlockGeometry {
    if let measured, measured.width == width { return measured.geometry }
    let geometry = BlockGeometry.make(
      containers: containers, placement: placement, width: width, rightToLeft: rightToLeft
    ) {
      ceil(contentHeight(width: $0))
    }
    measured = (width, geometry)
    return geometry
  }

  override func preferredLayoutAttributesFitting(_ layoutAttributes: UICollectionViewLayoutAttributes)
    -> UICollectionViewLayoutAttributes
  {
    let attributes = layoutAttributes.copy() as! UICollectionViewLayoutAttributes
    attributes.size.height = geometry(width: layoutAttributes.size.width).height
    return attributes
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let geometry = geometry(width: bounds.width)
    layoutContent(in: geometry.content)
    if !decoration.isHidden {
      decoration.frame = contentView.bounds
      decoration.update(geometry: geometry, style: style)
    }
  }
}

private final class DecorationView: UIView {
  private var geometry = BlockGeometry()
  private var style = DocumentStyle()

  func update(geometry: BlockGeometry, style: DocumentStyle) {
    self.geometry = geometry
    self.style = style
    setNeedsDisplay()
  }

  private func place(_ rect: CGRect) -> CGRect {
    guard geometry.rightToLeft else { return rect }
    return CGRect(x: bounds.width - rect.maxX, y: rect.minY, width: rect.width, height: rect.height)
  }

  override func draw(_ rect: CGRect) {
    let markerCenter = geometry.content.minY + style.lineHeight / 2
    for mark in geometry.marks {
      switch mark {
      case .band(let x, let right, let top, let first, let last, let tone):
        let colors = style.callout(tone)
        var corners: UIRectCorner = []
        if first { corners.formUnion([.topLeft, .topRight]) }
        if last { corners.formUnion([.bottomLeft, .bottomRight]) }
        colors.tint.setFill()
        UIBezierPath(
          roundedRect: place(CGRect(x: x, y: top, width: right - x, height: bounds.height - top)),
          byRoundingCorners: corners,
          cornerRadii: CGSize(width: 10, height: 10)
        ).fill()
        if first {
          let label = NSAttributedString(
            string: style.calloutLabel(tone), attributes: [.font: style.calloutLabelFont, .foregroundColor: colors.label])
          let size = label.size()
          let origin = CGPoint(x: x + DocumentStyle.calloutPadding + 2, y: top + DocumentStyle.calloutPadding)
          label.draw(at: place(CGRect(origin: origin, size: size)).origin)
        }
      case .quoteBar(let x, let top, let bottomInset):
        style.border.setFill()
        UIBezierPath(
          roundedRect: place(CGRect(x: x + 1, y: top, width: 3, height: bounds.height - top - bottomInset)),
          cornerRadius: 1.5
        ).fill()
      case .bullet(let x, let level):
        let size: CGFloat = 6
        let dot = place(CGRect(x: x + 5, y: markerCenter - size / 2, width: size, height: size))
        if level % 2 == 0 {
          style.text.setFill()
          UIBezierPath(ovalIn: dot).fill()
        } else {
          style.text.setStroke()
          let ring = UIBezierPath(ovalIn: dot.insetBy(dx: 0.6, dy: 0.6))
          ring.lineWidth = 1.2
          ring.stroke()
        }
      case .number(let x, let text):
        let label = NSAttributedString(
          string: text,
          attributes: [
            .font: UIFont.monospacedDigitSystemFont(ofSize: style.fontSize, weight: .regular),
            .foregroundColor: style.muted,
          ])
        let size = label.size()
        let origin = CGPoint(x: x + DocumentStyle.indent - 4 - size.width, y: markerCenter - size.height / 2)
        label.draw(at: place(CGRect(origin: origin, size: size)).origin)
      case .checkbox(let x, let checked):
        let box = place(CGRect(x: x + 1, y: markerCenter - 8, width: 16, height: 16))
        let path = UIBezierPath(roundedRect: box.insetBy(dx: 0.75, dy: 0.75), cornerRadius: 4)
        if checked {
          style.accent.setFill()
          path.fill()
          let check = UIBezierPath()
          check.move(to: CGPoint(x: box.minX + 4, y: box.midY + 0.5))
          check.addLine(to: CGPoint(x: box.minX + 7, y: box.midY + 3.5))
          check.addLine(to: CGPoint(x: box.maxX - 4, y: box.minY + 5))
          check.lineWidth = 2
          check.lineCapStyle = .round
          check.lineJoinStyle = .round
          style.background.setStroke()
          check.stroke()
        } else {
          path.lineWidth = 1.5
          style.muted.setStroke()
          path.stroke()
        }
      }
    }
  }
}
