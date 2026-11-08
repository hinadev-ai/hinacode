import ExpoModulesCore
import UIKit

private extension NSAttributedString.Key {
  static let composerChip = NSAttributedString.Key("composerChip")
  static let composerChipIcon = NSAttributedString.Key("composerChipIcon")
}

private struct Theme {
  var text = UIColor.label
  var placeholder = UIColor.placeholderText
  var token = UIColor.systemBlue
  var tokenBackground = UIColor.clear
  var codeBackground = UIColor.systemGray5
  var muted = UIColor.secondaryLabel
  var caret = UIColor.systemBlue
}

/// Theme colors come from the app's palette, which uses `#rrggbb` and `rgba(r, g, b, a)`.
func parseCssColor(_ css: String) -> UIColor? {
  let value = css.trimmingCharacters(in: .whitespaces)
  if value.hasPrefix("#"), let hex = UInt32(value.dropFirst(), radix: 16), value.count == 7 {
    return UIColor(
      red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
      blue: CGFloat(hex & 0xff) / 255, alpha: 1)
  }
  guard value.hasPrefix("rgb"), let open = value.firstIndex(of: "("), let close = value.lastIndex(of: ")") else {
    return nil
  }
  let parts = value[value.index(after: open)..<close].split(separator: ",").compactMap {
    Double($0.trimmingCharacters(in: .whitespaces))
  }
  guard parts.count >= 3 else { return nil }
  return UIColor(
    red: parts[0] / 255, green: parts[1] / 255, blue: parts[2] / 255, alpha: parts.count > 3 ? parts[3] : 1)
}

/// Paints chip pills behind the text and each chip's icon over its transparent trigger character.
final class ChipLayoutManager: NSLayoutManager {
  var icons: [String: [(path: UIBezierPath, fill: Bool)]] = [:]
  var iconColor = UIColor.systemBlue

  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let storage = textStorage, let container = textContainers.first else { return }
    let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    storage.enumerateAttribute(.composerChip, in: characters) { value, range, _ in
      guard let color = value as? UIColor else { return }
      color.setFill()
      let glyphs = glyphRange(forCharacterRange: range, actualCharacterRange: nil)
      enumerateEnclosingRects(
        forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container
      ) { rect, _ in
        let pill = rect.offsetBy(dx: origin.x, dy: origin.y).insetBy(dx: -2, dy: 0)
        UIBezierPath(roundedRect: pill, cornerRadius: 4).fill()
      }
    }
  }

  override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
    guard let storage = textStorage, let container = textContainers.first,
      let context = UIGraphicsGetCurrentContext()
    else { return }
    let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    storage.enumerateAttribute(.composerChipIcon, in: characters) { value, range, _ in
      guard let name = value as? String, let shapes = icons[name],
        let font = storage.attribute(.font, at: range.location, effectiveRange: nil) as? UIFont
      else { return }
      let glyphs = glyphRange(forCharacterRange: NSRange(location: range.location, length: 1), actualCharacterRange: nil)
      let rect = boundingRect(forGlyphRange: glyphs, in: container).offsetBy(dx: origin.x, dy: origin.y)
      let size = font.pointSize * 0.9
      let baseline = rect.minY + location(forGlyphAt: glyphs.location).y
      let centerY = baseline - (font.ascender + font.descender) / 2
      context.saveGState()
      context.translateBy(x: rect.minX, y: centerY - size / 2)
      context.scaleBy(x: size / 24, y: size / 24)
      iconColor.setFill()
      iconColor.setStroke()
      for shape in shapes {
        shape.path.lineWidth = 2.4
        shape.path.lineCapStyle = .round
        shape.path.lineJoinStyle = .round
        if shape.fill { shape.path.fill() }
        shape.path.stroke()
      }
      context.restoreGState()
    }
  }
}

class ComposerEditorView: ExpoView, UITextViewDelegate {
  let onEditorChange = EventDispatcher()
  let onEditorSelection = EventDispatcher()
  let onEditorFocus = EventDispatcher()
  let onEditorBlur = EventDispatcher()
  let onEditorContentSize = EventDispatcher()

  private let layoutManager = ChipLayoutManager()
  let textView: UITextView
  private let placeholderLabel = UILabel()
  private var theme = Theme()
  private var font = UIFont.systemFont(ofSize: 16)
  private var lineHeight: CGFloat = 0
  private var document: (value: String, decorations: [[String: Any]], eventCount: Int)?
  private var eventCount = 0
  private var applying = false
  private var contentHeight: CGFloat = -1

  required init(appContext: AppContext? = nil) {
    let storage = NSTextStorage()
    let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
    container.widthTracksTextView = true
    container.lineFragmentPadding = 0
    storage.addLayoutManager(layoutManager)
    layoutManager.addTextContainer(container)
    textView = UITextView(frame: .zero, textContainer: container)
    super.init(appContext: appContext)
    textView.delegate = self
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    addSubview(textView)
    placeholderLabel.numberOfLines = 0
    textView.addSubview(placeholderLabel)
    applyBaseAttributes()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    let inset = textView.textContainerInset
    placeholderLabel.frame = CGRect(
      x: inset.left, y: inset.top, width: bounds.width - inset.left - inset.right, height: font.lineHeight)
    reportContentHeight()
  }

  /// Takes the text and decorations JS rendered, unless the document predates the editor's latest edit.
  func setDocument(_ json: String) {
    guard let object = decode(json), let value = object["value"] as? String else { return }
    let next = (
      value: value, decorations: object["decorations"] as? [[String: Any]] ?? [],
      eventCount: object["eventCount"] as? Int ?? 0
    )
    document = next
    guard next.eventCount >= eventCount else { return }
    if textView.text != value { withoutEvents { replaceChanged(with: value) } }
    applyDecorations()
  }

  func setIcons(_ json: String) {
    guard let object = decode(json) else { return }
    layoutManager.icons = object.compactMapValues { value in
      (value as? [[String: Any]])?.map { (path: IconPath.parse($0["d"] as? String ?? ""), fill: $0["fill"] as? Bool ?? false) }
    }
    applyDecorations()
  }

  func setTheme(_ json: String) {
    guard let object = decode(json) else { return }
    func color(_ key: String, _ fallback: UIColor) -> UIColor {
      (object[key] as? String).flatMap(parseCssColor) ?? fallback
    }
    let fallback = Theme()
    theme = Theme(
      text: color("text", fallback.text), placeholder: color("placeholder", fallback.placeholder),
      token: color("token", fallback.token), tokenBackground: color("tokenBackground", fallback.tokenBackground),
      codeBackground: color("codeBackground", fallback.codeBackground), muted: color("muted", fallback.muted),
      caret: color("caret", fallback.caret))
    textView.tintColor = theme.caret
    placeholderLabel.textColor = theme.placeholder
    layoutManager.iconColor = theme.token
    applyBaseAttributes()
    applyDecorations()
  }

  func setPlaceholder(_ text: String) {
    placeholderLabel.text = text
  }

  func setFontSize(_ size: CGFloat) {
    font = UIFont.systemFont(ofSize: size)
    placeholderLabel.font = font
    applyBaseAttributes()
    applyDecorations()
  }

  func setLineHeight(_ height: CGFloat) {
    lineHeight = height
    applyBaseAttributes()
    applyDecorations()
  }

  func setPadding(horizontal: CGFloat? = nil, vertical: CGFloat? = nil) {
    let inset = textView.textContainerInset
    let x = horizontal ?? inset.left
    let y = vertical ?? inset.top
    textView.textContainerInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    setNeedsLayout()
  }

  func select(start: Int, end: Int) {
    let length = (textView.text as NSString).length
    withoutEvents {
      textView.selectedRange = NSRange(location: min(start, length), length: max(0, min(end, length) - min(start, length)))
    }
  }

  func textViewDidChange(_ textView: UITextView) {
    placeholderLabel.isHidden = !textView.text.isEmpty
    if applying { return }
    eventCount += 1
    let selection = textView.selectedRange
    onEditorChange([
      "text": textView.text ?? "", "start": selection.location, "end": selection.location + selection.length,
      "eventCount": eventCount,
    ])
    reportContentHeight()
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    if applying { return }
    let selection = textView.selectedRange
    onEditorSelection(["start": selection.location, "end": selection.location + selection.length])
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    onEditorFocus()
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    onEditorBlur()
  }

  private func withoutEvents(_ block: () -> Void) {
    applying = true
    defer { applying = false }
    block()
  }

  private func decode(_ json: String) -> [String: Any]? {
    json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }

  private var baseAttributes: [NSAttributedString.Key: Any] {
    let paragraph = NSMutableParagraphStyle()
    if lineHeight > 0 {
      paragraph.minimumLineHeight = lineHeight
      paragraph.maximumLineHeight = lineHeight
    }
    return [.font: font, .foregroundColor: theme.text, .paragraphStyle: paragraph]
  }

  private func applyBaseAttributes() {
    textView.typingAttributes = baseAttributes
    placeholderLabel.font = font
  }

  /// Replaces only the part that differs, so the caret and the attributes outside it survive.
  private func replaceChanged(with value: String) {
    let current = textView.text as NSString
    let next = value as NSString
    var prefix = 0
    while prefix < current.length, prefix < next.length, current.character(at: prefix) == next.character(at: prefix) {
      prefix += 1
    }
    var suffix = 0
    while suffix < current.length - prefix, suffix < next.length - prefix,
      current.character(at: current.length - 1 - suffix) == next.character(at: next.length - 1 - suffix)
    {
      suffix += 1
    }
    let replaced = NSRange(location: prefix, length: current.length - suffix - prefix)
    let inserted = next.substring(with: NSRange(location: prefix, length: next.length - suffix - prefix))
    textView.textStorage.replaceCharacters(
      in: replaced, with: NSAttributedString(string: inserted, attributes: baseAttributes))
    textView.selectedRange = NSRange(location: prefix + (inserted as NSString).length, length: 0)
    placeholderLabel.isHidden = !value.isEmpty
  }

  /// Restyles the whole text. Skipped while the keyboard composes, since changing attributes ends the composition.
  private func applyDecorations() {
    guard let document, document.value == textView.text, textView.markedTextRange == nil else { return }
    let storage = textView.textStorage
    let full = NSRange(location: 0, length: storage.length)
    let selection = textView.selectedRange
    withoutEvents {
      storage.beginEditing()
      storage.setAttributes(baseAttributes, range: full)
      for decoration in document.decorations { add(decoration, to: storage) }
      storage.endEditing()
      textView.selectedRange = selection
    }
  }

  private func add(_ decoration: [String: Any], to storage: NSTextStorage) {
    let start = min(decoration["start"] as? Int ?? 0, storage.length)
    let end = min(max(decoration["end"] as? Int ?? 0, start), storage.length)
    guard end > start else { return }
    let range = NSRange(location: start, length: end - start)
    switch decoration["kind"] as? String {
    case "token":
      storage.addAttribute(.foregroundColor, value: theme.token, range: range)
    case "muted":
      storage.addAttribute(.foregroundColor, value: theme.muted, range: range)
    case "code":
      storage.addAttribute(.backgroundColor, value: theme.codeBackground, range: range)
    case "chip":
      storage.addAttributes([.foregroundColor: theme.token, .composerChip: theme.tokenBackground], range: range)
      guard let icon = decoration["icon"] as? String, layoutManager.icons[icon] != nil else { return }
      let trigger = NSRange(location: start, length: 1)
      let glyphWidth = storage.attributedSubstring(from: trigger).size().width
      let advance = font.pointSize * 1.1
      storage.addAttributes(
        [.foregroundColor: UIColor.clear, .composerChipIcon: icon, .kern: advance - glyphWidth], range: trigger)
    default:
      break
    }
  }

  private func reportContentHeight() {
    let used = layoutManager.usedRect(for: textView.textContainer).height
    let height = ceil(used + textView.textContainerInset.top + textView.textContainerInset.bottom)
    if height == contentHeight { return }
    contentHeight = height
    onEditorContentSize(["height": height])
  }
}
