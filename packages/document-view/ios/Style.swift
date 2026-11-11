import UIKit

func documentColor(_ css: String?) -> UIColor? {
  guard let value = css?.trimmingCharacters(in: .whitespaces) else { return nil }
  if value.hasPrefix("#"), value.count == 4, let hex = UInt32(value.dropFirst(), radix: 16) {
    return UIColor(
      red: CGFloat((hex >> 8) & 0xf) / 15, green: CGFloat((hex >> 4) & 0xf) / 15, blue: CGFloat(hex & 0xf) / 15,
      alpha: 1)
  }
  if value.hasPrefix("#"), value.count == 7, let hex = UInt32(value.dropFirst(), radix: 16) {
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

extension NSAttributedString.Key {
  static let documentHref = NSAttributedString.Key("HinaCodeDocumentHref")
}

struct CalloutColors {
  let ink: UIColor
  let tint: UIColor
  let label: UIColor
}

final class DocumentStyle {
  static let blockSpacing: CGFloat = 12
  static let listSpacing: CGFloat = 6
  static let headingSpacing: CGFloat = 22
  static let sidePadding: CGFloat = 16
  static let indent: CGFloat = 20
  static let readableWidth: CGFloat = 720
  static let calloutPadding: CGFloat = 12
  static let quoteSpacing: CGFloat = 4
  static let calloutLabelHeight: CGFloat = 22

  let text: UIColor
  let muted: UIColor
  let link: UIColor
  let background: UIColor
  let surface: UIColor
  let border: UIColor
  let codeBackground: UIColor
  let codeText: UIColor
  let accent: UIColor
  let chartLanes: [UIColor]
  let fontSize: CGFloat
  let lineHeight: CGFloat
  let codeFontSize: CGFloat
  let codeLineHeight: CGFloat
  let body: UIFont
  let mono: UIFont
  let codeFont: UIFont
  let calloutLabelFont: UIFont
  private let diagramRoles: [String: UIColor]
  private let callouts: [String: CalloutColors]
  private let calloutLabels: [String: String]
  private let monoName: String
  private var fontCache: [FontKey: UIFont] = [:]

  private struct FontKey: Hashable {
    let size: CGFloat
    let weight: CGFloat
    let marks: Int
  }

  init(json: [String: Any] = [:]) {
    func color(_ key: String, _ fallback: UIColor) -> UIColor { documentColor(json[key] as? String) ?? fallback }
    text = color("text", .label)
    muted = color("muted", .secondaryLabel)
    link = color("link", .link)
    background = color("background", .systemBackground)
    surface = color("surface", .secondarySystemBackground)
    border = color("border", .separator)
    codeBackground = color("codeBackground", .secondarySystemBackground)
    codeText = color("codeText", .label)
    accent = color("accent", .tintColor)
    let lanes = (json["chartLanes"] as? [String] ?? []).compactMap(documentColor)
    chartLanes = lanes.isEmpty ? [.systemBlue, .systemTeal, .systemOrange, .systemPink, .systemGreen, .systemGray] : lanes
    fontSize = CGFloat(json["fontSize"] as? Double ?? 16)
    lineHeight = CGFloat(json["lineHeight"] as? Double ?? 24)
    monoName = json["monoFont"] as? String ?? "Menlo"
    codeFontSize = (fontSize * 0.85).rounded()
    codeLineHeight = (codeFontSize * 1.45).rounded()
    body = .systemFont(ofSize: fontSize)
    mono = UIFont(name: monoName, size: (fontSize * 0.88).rounded()) ?? .monospacedSystemFont(ofSize: fontSize * 0.88, weight: .regular)
    codeFont = UIFont(name: monoName, size: codeFontSize) ?? .monospacedSystemFont(ofSize: codeFontSize, weight: .regular)
    calloutLabelFont = .systemFont(ofSize: 13, weight: .semibold)
    var callouts: [String: CalloutColors] = [:]
    for (tone, value) in json["callouts"] as? [String: [String: String]] ?? [:] {
      callouts[tone] = CalloutColors(
        ink: documentColor(value["ink"]) ?? .systemBlue, tint: documentColor(value["tint"]) ?? .secondarySystemBackground,
        label: documentColor(value["label"]) ?? .systemBlue)
    }
    self.callouts = callouts
    diagramRoles = (json["diagram"] as? [String: String] ?? [:]).compactMapValues(documentColor)
    calloutLabels = json["calloutLabels"] as? [String: String] ?? [:]
  }

  func callout(_ tone: String) -> CalloutColors {
    callouts[tone] ?? callouts["note"]
      ?? CalloutColors(ink: .systemBlue, tint: .secondarySystemBackground, label: .systemBlue)
  }

  var diagramForeground: UIColor { diagramRoles["fg"] ?? text }

  func diagramPaint(_ paint: String?) -> UIColor? {
    guard let paint, paint != "none" else { return nil }
    if paint.hasPrefix("@") { return diagramRoles[String(paint.dropFirst())] ?? diagramForeground }
    return documentColor(paint) ?? diagramForeground
  }

  func calloutLabel(_ tone: String) -> String { calloutLabels[tone] ?? calloutLabels["note"] ?? tone.capitalized }

  func headingSize(_ level: Int) -> CGFloat {
    switch level {
    case 1: return 28
    case 2: return 22
    case 3: return 19
    default: return 17
    }
  }

  func paragraphStyle(lineHeight: CGFloat, alignment: NSTextAlignment = .natural) -> NSParagraphStyle {
    let style = NSMutableParagraphStyle()
    style.minimumLineHeight = lineHeight
    style.maximumLineHeight = lineHeight
    style.alignment = alignment
    style.baseWritingDirection = .natural
    style.lineBreakMode = .byWordWrapping
    return style
  }

  func baselineOffset(lineHeight: CGFloat, font: UIFont) -> CGFloat { max(0, (lineHeight - font.lineHeight) / 2) }

  private func font(size: CGFloat, weight: UIFont.Weight, marks: Marks) -> UIFont {
    let key = FontKey(size: size, weight: weight.rawValue, marks: marks.rawValue)
    if let cached = fontCache[key] { return cached }
    var font: UIFont
    if marks.contains(.code) {
      let codeSize = (size * 0.88).rounded()
      font = UIFont(name: monoName, size: codeSize) ?? .monospacedSystemFont(ofSize: codeSize, weight: .regular)
    } else {
      font = .systemFont(ofSize: size, weight: marks.contains(.bold) ? .bold : weight)
    }
    var traits = font.fontDescriptor.symbolicTraits
    if marks.contains(.code), marks.contains(.bold) { traits.insert(.traitBold) }
    if marks.contains(.italic) { traits.insert(.traitItalic) }
    if traits != font.fontDescriptor.symbolicTraits, let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
      font = UIFont(descriptor: descriptor, size: font.pointSize)
    }
    fontCache[key] = font
    return font
  }

  func text(
    _ runs: [Run], size: CGFloat? = nil, lineHeight: CGFloat? = nil, weight: UIFont.Weight = .regular,
    color: UIColor? = nil, alignment: NSTextAlignment = .natural, image: (Run) -> NSAttributedString? = { _ in nil }
  ) -> NSAttributedString {
    let size = size ?? fontSize
    let lineHeight = lineHeight ?? self.lineHeight
    let paragraph = paragraphStyle(lineHeight: lineHeight, alignment: alignment)
    let result = NSMutableAttributedString()
    for run in runs {
      if run.image != nil, let attachment = image(run) {
        result.append(attachment)
        continue
      }
      let font = font(size: size, weight: weight, marks: run.marks)
      var attributes: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color ?? text,
        .paragraphStyle: paragraph,
        .baselineOffset: baselineOffset(lineHeight: lineHeight, font: font),
      ]
      if run.marks.contains(.strike) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if run.marks.contains(.code) { attributes[.backgroundColor] = codeBackground }
      if let href = run.href, let url = URL(string: href) ?? URL(string: href.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed) ?? "") {
        attributes[.link] = url
        attributes[.documentHref] = href
        attributes[.foregroundColor] = link
      }
      result.append(NSAttributedString(string: run.text, attributes: attributes))
    }
    return result
  }

  func plain(_ string: String, font: UIFont, color: UIColor, lineHeight: CGFloat, alignment: NSTextAlignment = .natural)
    -> NSAttributedString
  {
    NSAttributedString(
      string: string,
      attributes: [
        .font: font, .foregroundColor: color,
        .paragraphStyle: paragraphStyle(lineHeight: lineHeight, alignment: alignment),
        .baselineOffset: baselineOffset(lineHeight: lineHeight, font: font),
      ])
  }
}
