import UIKit

final class CodeLinesPainter: CanvasPainter {
  let size: CGSize
  private let lines: [NSAttributedString]
  private let lineHeight: CGFloat
  private let lineOffset: CGFloat

  init(text: String, tokens: [CodeToken], style: DocumentStyle) {
    let whole = NSMutableAttributedString(
      string: text, attributes: [.font: style.codeFont, .foregroundColor: style.codeText])
    let length = whole.length
    for token in tokens {
      let start = max(0, min(token.start, length))
      let end = max(start, min(token.end, length))
      if end > start, let color = documentColor(token.color) {
        whole.addAttribute(.foregroundColor, value: color, range: NSRange(location: start, length: end - start))
      }
    }
    let string = whole.string as NSString
    var lines: [NSAttributedString] = []
    var start = 0
    while true {
      let newline = string.range(of: "\n", range: NSRange(location: start, length: length - start))
      let end = newline.location == NSNotFound ? length : newline.location
      lines.append(whole.attributedSubstring(from: NSRange(location: start, length: end - start)))
      if newline.location == NSNotFound { break }
      start = end + 1
    }
    let width = lines.reduce(0) { max($0, $1.length == 0 ? 0 : ceil($1.size().width)) }
    self.lines = lines
    lineHeight = style.codeLineHeight
    lineOffset = (style.codeLineHeight - style.codeFont.lineHeight) / 2
    size = CGSize(width: max(1, width), height: CGFloat(lines.count) * style.codeLineHeight)
  }

  func paint(_ rect: CGRect) {
    let first = max(0, Int(floor(rect.minY / lineHeight)))
    let last = min(lines.count - 1, Int(ceil(rect.maxY / lineHeight)))
    guard first <= last else { return }
    for index in first...last where lines[index].length > 0 {
      lines[index].draw(at: CGPoint(x: 0, y: CGFloat(index) * lineHeight + lineOffset))
    }
  }
}

final class CodeBlockCell: BlockCell {
  private static let padding: CGFloat = 12
  private static let headerHeight: CGFloat = 22
  private let box = UIView()
  private let header = UILabel()
  private let scroller = UIScrollView()
  private let lines = CanvasHost()
  private let error = UILabel()
  private var code: CodeLinesPainter?

  override init(frame: CGRect) {
    super.init(frame: frame)
    box.layer.cornerRadius = 8
    box.layer.cornerCurve = .continuous
    box.clipsToBounds = true
    scroller.showsVerticalScrollIndicator = false
    scroller.alwaysBounceVertical = false
    scroller.contentInset = UIEdgeInsets(top: 0, left: Self.padding, bottom: 0, right: Self.padding)
    scroller.addSubview(lines)
    header.font = .systemFont(ofSize: 12, weight: .semibold)
    error.numberOfLines = 0
    error.font = .systemFont(ofSize: 13)
    box.addSubview(header)
    box.addSubview(scroller)
    contentView.addSubview(box)
    contentView.addSubview(error)
  }

  required init?(coder: NSCoder) { nil }

  func configure(
    _ block: Block, placement: Placement, style: DocumentStyle, label: String, code: CodeLinesPainter, error: String?
  ) {
    super.configure(block, placement: placement, style: style)
    self.code = code
    box.backgroundColor = style.codeBackground
    header.text = label
    header.textColor = style.muted
    header.isHidden = label.isEmpty
    self.error.text = error
    self.error.textColor = style.muted
    self.error.isHidden = error == nil
    lines.show(code)
    scroller.contentSize = code.size
    scroller.contentOffset = CGPoint(x: -Self.padding, y: 0)
  }

  private var headerSpace: CGFloat { header.isHidden ? 0 : Self.headerHeight }

  private func errorHeight(width: CGFloat) -> CGFloat {
    error.isHidden ? 0 : 6 + ceil(error.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
  }

  override func contentHeight(width: CGFloat) -> CGFloat {
    Self.padding * 2 + headerSpace + (code?.size.height ?? 0) + errorHeight(width: width)
  }

  override func layoutContent(in frame: CGRect) {
    let codeHeight = code?.size.height ?? 0
    let boxHeight = Self.padding * 2 + headerSpace + codeHeight
    box.frame = CGRect(x: frame.minX, y: frame.minY, width: frame.width, height: boxHeight)
    header.frame = CGRect(x: Self.padding, y: Self.padding - 2, width: frame.width - Self.padding * 2, height: 16)
    scroller.frame = CGRect(x: 0, y: Self.padding + headerSpace, width: frame.width, height: codeHeight)
    lines.frame = CGRect(origin: .zero, size: code?.size ?? .zero)
    error.frame = CGRect(x: frame.minX, y: box.frame.maxY + 6, width: frame.width, height: errorHeight(width: frame.width) - 6)
  }
}
