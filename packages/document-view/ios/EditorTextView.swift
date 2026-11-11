import UIKit

enum StructuralKey: String {
  case enter = "Enter"
  case backspace = "Backspace"
  case delete = "Delete"
  case tab = "Tab"
}

/// Undo and redo are model actions, so the text view must never offer its own: not from shake, the three-finger
/// gestures or the keyboard's undo key.
private final class NoUndoManager: UndoManager {
  override init() {
    super.init()
    disableUndoRegistration()
  }

  override func enableUndoRegistration() {}
  override var canUndo: Bool { false }
  override var canRedo: Bool { false }
  override func undo() {}
  override func redo() {}
}

/// The one editable text view. It edits the focused block's text and hands every key that changes structure to
/// `onKey` instead of changing its text.
final class EditorTextView: UITextView {
  var onKey: (StructuralKey, Bool) -> Void = { _, _ in }
  private let noUndo = NoUndoManager()

  init() {
    super.init(frame: .zero, textContainer: nil)
    isScrollEnabled = false
    backgroundColor = .clear
    textContainerInset = .zero
    textContainer.lineFragmentPadding = 0
    linkTextAttributes = [:]
  }

  required init?(coder: NSCoder) { nil }

  override var undoManager: UndoManager? { noUndo }

  override var editingInteractionConfiguration: UIEditingInteractionConfiguration { .none }

  private var caretAtStart: Bool { markedTextRange == nil && selectedRange == NSRange(location: 0, length: 0) }

  private var caretAtEnd: Bool {
    markedTextRange == nil && selectedRange.length == 0 && selectedRange.location == (text as NSString).length
  }

  override func deleteBackward() {
    if caretAtStart { onKey(.backspace, false) } else { super.deleteBackward() }
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    guard markedTextRange == nil, presses.count == 1, let key = presses.first?.key else {
      return super.pressesBegan(presses, with: event)
    }
    let shift = key.modifierFlags.contains(.shift)
    let others = key.modifierFlags.subtracting([.shift, .numericPad]).isEmpty == false
    switch key.keyCode {
    case .keyboardReturnOrEnter where shift && !others: onKey(.enter, true)
    case .keyboardTab where !others: onKey(.tab, shift)
    case .keyboardDeleteForward where !others && caretAtEnd: onKey(.delete, false)
    default: super.pressesBegan(presses, with: event)
    }
  }
}

struct TextDiff: Equatable {
  let from: Int
  let to: Int
  let text: String

  /// The one replacement that turns `old` into `new`, in UTF-16 units, never splitting a surrogate pair.
  static func between(_ old: NSString, _ new: NSString) -> TextDiff? {
    if old.isEqual(to: new as String) { return nil }
    let oldLength = old.length
    let newLength = new.length
    let shorter = min(oldLength, newLength)
    var prefix = 0
    while prefix < shorter, old.character(at: prefix) == new.character(at: prefix) { prefix += 1 }
    if prefix > 0, UTF16.isLeadSurrogate(old.character(at: prefix - 1)) { prefix -= 1 }
    var suffix = 0
    while suffix < shorter - prefix,
      old.character(at: oldLength - 1 - suffix) == new.character(at: newLength - 1 - suffix)
    {
      suffix += 1
    }
    if suffix > 0, UTF16.isTrailSurrogate(new.character(at: newLength - suffix)) { suffix -= 1 }
    return TextDiff(
      from: prefix, to: oldLength - suffix,
      text: new.substring(with: NSRange(location: prefix, length: newLength - suffix - prefix)))
  }

  /// Where an offset the model held lands after the model applies this replacement.
  func map(_ offset: Int) -> Int {
    if offset >= to { return offset + (text as NSString).length - (to - from) }
    if offset >= from { return from + (text as NSString).length }
    return offset
  }
}
