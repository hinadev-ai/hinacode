import UIKit

final class TextBlockCell: BlockCell, UITextViewDelegate {
  private let textView = UITextView(usingTextLayoutManager: true)
  private var onLink: (String) -> Void = { _ in }

  override init(frame: CGRect) {
    super.init(frame: frame)
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.linkTextAttributes = [:]
    textView.delegate = self
    contentView.addSubview(textView)
  }

  required init?(coder: NSCoder) { nil }

  func configure(
    _ block: Block, placement: Placement, style: DocumentStyle, text: NSAttributedString,
    onLink: @escaping (String) -> Void
  ) {
    super.configure(block, placement: placement, style: style)
    self.onLink = onLink
    textView.attributedText = text
  }

  override func contentHeight(width: CGFloat) -> CGFloat {
    textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
  }

  override func layoutContent(in frame: CGRect) {
    textView.frame = frame
  }

  @available(iOS 17.0, *)
  func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
    guard case .link(let url) = textItem.content else { return defaultAction }
    let href = href(at: textItem.range) ?? url.absoluteString
    return UIAction { [onLink] _ in onLink(href) }
  }

  func textView(
    _ textView: UITextView, shouldInteractWith url: URL, in characterRange: NSRange, interaction: UITextItemInteraction
  ) -> Bool {
    if interaction == .invokeDefaultAction { onLink(href(at: characterRange) ?? url.absoluteString) }
    return false
  }

  private func href(at range: NSRange) -> String? {
    guard range.location < textView.attributedText.length else { return nil }
    return textView.attributedText.attribute(.documentHref, at: range.location, effectiveRange: nil) as? String
  }
}
