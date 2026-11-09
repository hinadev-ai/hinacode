import UIKit

extension NSAttributedString.Key {
  static let composerChip = NSAttributedString.Key("composerChip")
  static let composerChipIcon = NSAttributedString.Key("composerChipIcon")
}

/// Paints chip pills behind the text and each chip's icon over its transparent trigger character.
final class ChipLayoutManager: NSLayoutManager {
  var icons: [String: [(path: UIBezierPath, fill: Bool)]] = [:] {
    didSet { images.removeAll() }
  }
  var iconColor = UIColor.systemBlue {
    didSet { images.removeAll() }
  }
  /// The caret blink redraws the text twice a second, so each icon is stroked once per size and drawn as an image.
  private var images: [String: UIImage] = [:]

  /// Styles `range` as a chip: a bold label on the pill and, when `icon` is given, the icon over its first character.
  static func styleChip(
    _ range: NSRange, icon: String?, in storage: NSTextStorage, font: UIFont, color: UIColor, background: UIColor
  ) {
    let bold = UIFont.systemFont(ofSize: font.pointSize, weight: .semibold)
    storage.addAttributes([.font: bold, .foregroundColor: color, .composerChip: background], range: range)
    if let icon { markIcon(icon, at: range.location, in: storage, font: bold) }
  }

  /// Hides the chip's trigger character at `index` and widens it to make room for the icon drawn over it.
  private static func markIcon(_ icon: String, at index: Int, in storage: NSTextStorage, font: UIFont) {
    let trigger = NSRange(location: index, length: 1)
    let glyphWidth = storage.attributedSubstring(from: trigger).size().width
    storage.addAttributes(
      [.foregroundColor: UIColor.clear, .composerChipIcon: icon, .kern: iconAdvance(font) - glyphWidth],
      range: trigger)
  }

  private static func iconAdvance(_ font: UIFont) -> CGFloat { font.pointSize * 1.1 }
  private static func iconSize(_ font: UIFont) -> CGFloat { font.pointSize * 0.9 }

  private func image(_ name: String, size: CGFloat) -> UIImage? {
    let key = "\(name)@\(size)"
    if let image = images[key] { return image }
    guard let shapes = icons[name] else { return nil }
    let image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { renderer in
      renderer.cgContext.scaleBy(x: size / 24, y: size / 24)
      iconColor.setFill()
      iconColor.setStroke()
      for shape in shapes {
        shape.path.lineWidth = 2.4
        shape.path.lineCapStyle = .round
        shape.path.lineJoinStyle = .round
        if shape.fill { shape.path.fill() }
        shape.path.stroke()
      }
    }
    images[key] = image
    return image
  }

  /// The pills behind the chip covering `characters`, in container coordinates, one per line it spans.
  func pillRects(forCharacterRange characters: NSRange) -> [CGRect] {
    guard let container = textContainers.first else { return [] }
    var rects: [CGRect] = []
    let glyphs = glyphRange(forCharacterRange: characters, actualCharacterRange: nil)
    enumerateEnclosingRects(
      forGlyphRange: glyphs, withinSelectedGlyphRange: NSRange(location: NSNotFound, length: 0), in: container
    ) { rect, _ in rects.append(rect.insetBy(dx: -2, dy: 0)) }
    return rects
  }

  /**
   Where the icon over the trigger character at `index` is drawn, in container coordinates: centred in the space the
   trigger's kern makes and on the pill's line. The glyph's bounding rect is no guide, since a fixed line height
   shifts it away from where the glyph is laid out.
   */
  func iconRect(forCharacterAt index: Int) -> CGRect? {
    guard let storage = textStorage,
      let font = storage.attribute(.font, at: index, effectiveRange: nil) as? UIFont
    else { return nil }
    let glyph = glyphIndexForCharacter(at: index)
    let line = lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
    let size = Self.iconSize(font)
    let x = line.minX + location(forGlyphAt: glyph).x + (Self.iconAdvance(font) - size) / 2
    return CGRect(x: x, y: line.midY - size / 2, width: size, height: size)
  }

  override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
    guard let storage = textStorage else { return }
    let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    storage.enumerateAttribute(.composerChip, in: characters) { value, range, _ in
      guard let color = value as? UIColor else { return }
      color.setFill()
      for pill in pillRects(forCharacterRange: range) {
        UIBezierPath(roundedRect: pill.offsetBy(dx: origin.x, dy: origin.y), cornerRadius: 4).fill()
      }
    }
  }

  override func drawGlyphs(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
    super.drawGlyphs(forGlyphRange: glyphsToShow, at: origin)
    guard let storage = textStorage else { return }
    let characters = characterRange(forGlyphRange: glyphsToShow, actualGlyphRange: nil)
    storage.enumerateAttribute(.composerChipIcon, in: characters) { value, range, _ in
      guard let name = value as? String, let rect = iconRect(forCharacterAt: range.location) else { return }
      image(name, size: rect.width)?.draw(at: rect.offsetBy(dx: origin.x, dy: origin.y).origin)
    }
  }
}
