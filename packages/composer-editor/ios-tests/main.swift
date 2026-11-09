import UIKit

var failures = 0

func check(_ passed: Bool, _ message: @autoclosure () -> String) {
  if passed { return }
  failures += 1
  print("FAIL: \(message())")
}

/// Lays out a leading skill chip the way `ComposerEditorView` does and checks its weight and where its icon lands.
func checkChipIcon(fontSize: CGFloat, lineHeight: CGFloat) {
  let text = "/artifact:writing "
  let font = UIFont.systemFont(ofSize: fontSize)
  let paragraph = NSMutableParagraphStyle()
  paragraph.minimumLineHeight = lineHeight
  paragraph.maximumLineHeight = lineHeight
  let storage = NSTextStorage(string: text, attributes: [.font: font, .paragraphStyle: paragraph])
  let layout = ChipLayoutManager()
  let container = NSTextContainer(size: CGSize(width: 320, height: CGFloat.greatestFiniteMagnitude))
  container.lineFragmentPadding = 0
  storage.addLayoutManager(layout)
  layout.addTextContainer(container)

  let chip = NSRange(location: 0, length: text.count - 1)
  ChipLayoutManager.styleChip(chip, icon: "skill", in: storage, font: font, color: .blue, background: .red)
  layout.ensureLayout(for: container)

  let label = "\(fontSize)pt on a \(lineHeight)pt line"
  let chipFont = storage.attribute(.font, at: 1, effectiveRange: nil) as? UIFont
  check(chipFont?.fontDescriptor.symbolicTraits.contains(.traitBold) == true, "\(label): chip label is not bold")
  let afterChip = storage.attribute(.font, at: chip.length, effectiveRange: nil) as? UIFont
  check(afterChip?.fontDescriptor.symbolicTraits.contains(.traitBold) == false, "\(label): text after the chip is bold")
  guard let icon = layout.iconRect(forCharacterAt: 0), let pill = layout.pillRects(forCharacterRange: chip).first else {
    return check(false, "\(label): no icon or pill")
  }
  let labelGlyph = layout.glyphIndexForCharacter(at: 1)
  let labelStart =
    layout.lineFragmentRect(forGlyphAt: labelGlyph, effectiveRange: nil).minX + layout.location(forGlyphAt: labelGlyph).x
  check(icon.minX >= pill.minX, "\(label): icon starts at \(icon.minX), left of the pill at \(pill.minX)")
  check(icon.maxX <= labelStart, "\(label): icon ends at \(icon.maxX), over the label at \(labelStart)")
  check(abs(icon.midY - pill.midY) <= 0.5, "\(label): icon centred at \(icon.midY), the pill at \(pill.midY)")
}

checkChipIcon(fontSize: 17, lineHeight: 20)
checkChipIcon(fontSize: 15, lineHeight: 22)
checkChipIcon(fontSize: 20, lineHeight: 0)

print(failures == 0 ? "ok: chip style and icon layout" : "\(failures) failed")
exit(failures == 0 ? 0 : 1)
