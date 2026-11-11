import UIKit

struct Focus: Equatable {
  var key: String
  var cell: TableCellIndex?
}

/// What the focused block shows while it holds the editor.
struct EditingContent {
  let text: NSAttributedString
  let base: [NSAttributedString.Key: Any]
  let isSource: Bool
  let background: UIColor
}

final class EditingState {
  var editable = false
  var formatActions: [(id: String, label: String)] = []
  var focus: Focus?
  var lastFocus: (focus: Focus, selection: NSRange)?
  var indexHint = 0
  var eventCount = 0
  /// The focused block's text as the model holds it once it has applied every edit sent so far.
  var shown: NSString = ""
  /// The model's selection in the focused block's offsets, as far as this view knows.
  var modelSelection: NSRange?
  var held: [BlockPatch] = []
  var applyingModel = false
  var lostFocusedBlock = false
  var keyboardOverlap: CGFloat = 0
  var base: [NSAttributedString.Key: Any] = [:]
  var minimumLineHeight: CGFloat = 0
  lazy var editor = EditorTextView()
  var hasEditor = false
  let tap = UITapGestureRecognizer()
}

private enum Caret {
  case range(NSRange)
  case point(CGPoint)
}

extension DocumentBlocksView: UITextViewDelegate, UIGestureRecognizerDelegate {
  func setUpEditing() {
    editing.tap.addTarget(self, action: #selector(tapped(_:)))
    editing.tap.delegate = self
    editing.tap.isEnabled = false
    collectionView.addGestureRecognizer(editing.tap)
    collectionView.onLayout = { [weak self] in self?.placeEditor() }
    NotificationCenter.default.addObserver(
      self, selector: #selector(keyboardWillChangeFrame(_:)), name: UIResponder.keyboardWillChangeFrameNotification,
      object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
  }

  private var editor: EditorTextView {
    if !editing.hasEditor {
      editing.hasEditor = true
      let editor = editing.editor
      editor.delegate = self
      editor.onKey = { [weak self] key, shift in self?.press(key, shift: shift) }
      collectionView.addSubview(editor)
    }
    return editing.editor
  }

  private var isEditing: Bool { editing.hasEditor && editing.editor.isFirstResponder }

  // MARK: Props and view functions

  func setEditable(_ editable: Bool) {
    guard editable != editing.editable else { return }
    editing.editable = editable
    editing.tap.isEnabled = editable
    if !editable { blurDocument() }
    reconfigure(items.map(\.key))
  }

  func setFormatActions(_ json: String) {
    let list = json.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]
    editing.formatActions = (list ?? []).compactMap { entry in
      guard let id = entry["id"] as? String, let label = entry["label"] as? String else { return nil }
      return (id, label)
    }
  }

  func focusDocument() {
    guard editing.editable else { return }
    if let last = editing.lastFocus, let index = index(of: last.focus.key),
      items[index].block.editableText(cell: last.focus.cell) != nil
    {
      return focus(last.focus, at: index, caret: .range(last.selection), reveal: true)
    }
    guard let index = items.firstIndex(where: { $0.block.isTextBlock }) else { return }
    let length = ((items[index].block.editableText(cell: nil) ?? "") as NSString).length
    focus(Focus(key: items[index].key, cell: nil), at: index, caret: .range(NSRange(location: length, length: 0)), reveal: true)
  }

  func blurDocument() {
    if isEditing { editing.editor.resignFirstResponder() }
  }

  // MARK: Focus

  func focusedIndex() -> Int? {
    guard let key = editing.focus?.key else { return nil }
    if editing.indexHint < items.count, items[editing.indexHint].key == key { return editing.indexHint }
    guard let found = index(of: key) else { return nil }
    editing.indexHint = found
    return found
  }

  private func index(of key: String) -> Int? { items.firstIndex { $0.key == key } }

  func host(_ cell: BlockCell, _ key: String) {
    guard editing.focus?.key == key else {
      if cell.editorHeight != nil { cell.hostEditor(nil) }
      return
    }
    cell.hostEditor { [unowned self] width in editorHeight(width: width) }
    if let table = cell as? TableCell, let at = editing.focus?.cell { table.reveal(at) }
  }

  private func editorHeight(width: CGFloat) -> CGFloat {
    let fitting = editing.editor.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    return ceil(max(fitting, editing.minimumLineHeight))
  }

  /// `fromModel` places the caret where a patch put it without reporting it back.
  private func focus(_ target: Focus, at index: Int, caret: Caret, reveal: Bool = false, fromModel: Bool = false) {
    let item = items[index]
    guard let content = editingContent(item, cell: target.cell) else { return blurDocument() }
    let editor = self.editor
    let previous = editing.focus
    editing.applyingModel = true
    defer { editing.applyingModel = false }
    editing.focus = target
    editing.indexHint = index
    editing.lostFocusedBlock = false
    if previous != target {
      show(content, in: editor)
      editing.shown = NSString(string: editor.textStorage.string)
      editing.modelSelection = nil
      refresh([previous?.key, target.key].compactMap { $0 })
    }
    if reveal { collectionView.scrollToItem(at: IndexPath(item: index, section: 0), at: .centeredVertically, animated: false) }
    collectionView.layoutIfNeeded()
    placeEditor()
    if !editor.isFirstResponder { editor.becomeFirstResponder() }
    switch caret {
    case .range(let range):
      editor.selectedRange = clamp(range, to: editor.textStorage.length)
    case .point(let point):
      editor.layoutIfNeeded()
      let position = editor.closestPosition(to: editor.convert(point, from: collectionView)) ?? editor.endOfDocument
      editor.selectedRange = NSRange(location: editor.offset(from: editor.beginningOfDocument, to: position), length: 0)
    }
    editing.applyingModel = false
    if fromModel { editing.modelSelection = editor.selectedRange } else { reportSelection() }
    revealCaret()
  }

  private func show(_ content: EditingContent, in editor: EditorTextView) {
    editor.attributedText = content.text
    editor.backgroundColor = content.background
    editing.base = content.base
    editing.minimumLineHeight = (content.base[.paragraphStyle] as? NSParagraphStyle)?.minimumLineHeight ?? 0
    if content.text.length == 0 { editor.typingAttributes = content.base }
    let source = content.isSource
    let correction: UITextAutocorrectionType = source ? .no : .default
    if editor.autocorrectionType != correction {
      editor.autocorrectionType = correction
      editor.autocapitalizationType = source ? .none : .sentences
      editor.smartQuotesType = source ? .no : .default
      editor.smartDashesType = source ? .no : .default
      editor.spellCheckingType = source ? .no : .default
      if editor.isFirstResponder { editor.reloadInputViews() }
    }
  }

  /// Reconfigures rows whose editor hosting changed. A chart or diagram changes cell class with focus, so it reloads.
  private func refresh(_ keys: [String]) {
    var snapshot = dataSource.snapshot()
    let present = Set(keys).filter { snapshot.indexOfItem($0) != nil }
    guard !present.isEmpty else { return }
    let reload = present.filter { key in
      guard let index = index(of: key) else { return false }
      switch items[index].block.body {
      case .chart, .diagram: return true
      default: return false
      }
    }
    snapshot.reloadItems(Array(reload))
    snapshot.reconfigureItems(Array(present.subtracting(reload)))
    dataSource.apply(snapshot, animatingDifferences: false)
    for key in present { if let index = index(of: key) { remeasure(index) } }
  }

  private func remeasure(_ index: Int) {
    guard let cell = collectionView.cellForItem(at: IndexPath(item: index, section: 0)) as? BlockCell else { return }
    cell.invalidateMeasure()
    layout.setHeight(index, cell.height(width: collectionView.bounds.width))
  }

  private func unfocus() {
    guard let focus = editing.focus else { return }
    editing.lastFocus = (focus, editing.editor.selectedRange)
    editing.focus = nil
    editing.modelSelection = nil
    editing.editor.isHidden = true
    refresh([focus.key])
  }

  func placeEditor() {
    guard editing.hasEditor else { return }
    let editor = editing.editor
    guard let focus = editing.focus, let index = focusedIndex(),
      let cell = collectionView.cellForItem(at: IndexPath(item: index, section: 0)) as? BlockCell,
      var frame = cell.editorFrame(cell: focus.cell)
    else {
      if editing.focus == nil, !editor.isHidden { editor.isHidden = true }
      return
    }
    frame = cell.convert(frame, to: collectionView)
    if focus.cell != nil { frame.size.height = max(frame.height, editorHeight(width: frame.width)) }
    if editor.isHidden { editor.isHidden = false }
    if editor.frame != frame { editor.frame = frame }
    if collectionView.subviews.last !== editor { collectionView.bringSubviewToFront(editor) }
  }

  // MARK: What the editor shows

  private func editingContent(_ item: Item, cell: TableCellIndex?) -> EditingContent? {
    guard item.block.editableText(cell: cell) != nil else { return nil }
    switch item.block.body {
    case .paragraph(let runs), .heading(_, let runs):
      let build = { [unowned self] (runs: [Run]) -> NSAttributedString in
        let image = { [unowned self] (run: Run) in inlineImage(run, for: item.key, keepsLength: true) }
        if case .heading(let level, _) = item.block.body {
          let size = style.headingSize(level)
          return style.text(runs, size: size, lineHeight: (size * 1.3).rounded(), weight: .semibold, image: image)
        }
        return style.text(runs, image: image)
      }
      return EditingContent(
        text: build(runs), base: build([Run(text: " ", marks: [], href: nil, image: nil, alt: nil)]).attributes(at: 0, effectiveRange: nil),
        isSource: false, background: .clear)
    case .code(_, let text, let tokens, _):
      return sourceContent(text, tokens: tokens)
    case .chart(let chart):
      return sourceContent(chart.source, tokens: [])
    case .diagram(let source, _):
      return sourceContent(source, tokens: [])
    case .table(let table):
      guard let cell else { return nil }
      let painter = cached(item.key) { TablePainter(table: table, style: style) }
      guard let text = painter.text(cell) else { return nil }
      let header = painter.isHeader(cell)
      let base =
        text.length > 0
        ? text.attributes(at: 0, effectiveRange: nil)
        : style.text(
          [Run(text: " ", marks: [], href: nil, image: nil, alt: nil)], size: style.fontSize - 1,
          lineHeight: style.lineHeight - 3, weight: header ? .semibold : .regular
        ).attributes(at: 0, effectiveRange: nil)
      return EditingContent(text: text, base: base, isSource: false, background: header ? style.surface : style.background)
    case .image, .rule, .unsupported:
      return nil
    }
  }

  private func sourceContent(_ source: String, tokens: [CodeToken]) -> EditingContent {
    let base = style.plain(" ", font: style.codeFont, color: style.codeText, lineHeight: style.codeLineHeight)
      .attributes(at: 0, effectiveRange: nil)
    let text = NSMutableAttributedString(string: source, attributes: base)
    for token in tokens {
      let start = max(0, min(token.start, text.length))
      let end = max(start, min(token.end, text.length))
      if end > start, let color = documentColor(token.color) {
        text.addAttribute(.foregroundColor, value: color, range: NSRange(location: start, length: end - start))
      }
    }
    return EditingContent(text: text, base: base, isSource: true, background: .clear)
  }

  // MARK: Patches

  /// A patch that touches the focused block waits while the editor holds marked text, and every patch after it waits
  /// with it so they apply in order.
  func holds(_ patch: BlockPatch) -> Bool {
    if !editing.held.isEmpty { return true }
    guard isEditing, editing.editor.markedTextRange != nil, let index = focusedIndex() else { return false }
    return (patch.start..<(patch.start + patch.deleteCount)).contains(index) || patch.selection != nil
  }

  func flushHeldPatches() {
    guard !editing.held.isEmpty, !(isEditing && editing.editor.markedTextRange != nil) else { return }
    let held = editing.held
    editing.held = []
    for patch in held { apply(patch) }
  }

  /// The focused block was replaced. The block at the same place in the replacement takes over, and the editor keeps
  /// its text unless the patch is current and says otherwise.
  func followFocus(into inserted: [Item], at offset: Int, fresh: Bool) {
    guard var focus = editing.focus, !inserted.isEmpty else {
      editing.lostFocusedBlock = true
      return
    }
    let item = inserted[min(offset, inserted.count - 1)]
    guard let text = item.block.editableText(cell: focus.cell) else {
      editing.lostFocusedBlock = true
      return
    }
    focus.key = item.key
    editing.focus = focus
    editing.indexHint = items.firstIndex { $0.key == item.key } ?? 0
    guard fresh, let content = editingContent(item, cell: focus.cell) else { return }
    let editor = editing.editor
    editing.applyingModel = true
    defer { editing.applyingModel = false }
    if text == editor.textStorage.string, content.isSource == isSourceEditor {
      restyle(editor, with: content)
    } else {
      let selection = editor.selectedRange
      show(content, in: editor)
      editor.selectedRange = clamp(selection, to: editor.textStorage.length)
      editing.shown = NSString(string: editor.textStorage.string)
    }
  }

  private var isSourceEditor: Bool { editing.base[.font] as? UIFont == style.codeFont }

  private func restyle(_ editor: EditorTextView, with content: EditingContent) {
    let storage = editor.textStorage
    storage.beginEditing()
    content.text.enumerateAttributes(in: NSRange(location: 0, length: content.text.length)) { attributes, range, _ in
      storage.setAttributes(attributes, range: range)
    }
    storage.endEditing()
    editing.base = content.base
    let caret = editor.selectedRange.location
    editor.typingAttributes =
      caret > 0 && caret <= storage.length ? storage.attributes(at: caret - 1, effectiveRange: nil) : content.base
  }

  func finish(_ patch: BlockPatch) {
    let fresh = patch.eventCount >= editing.eventCount
    if let selection = patch.selection, fresh {
      return select(selection.anchor, selection.head)
    }
    if editing.lostFocusedBlock {
      editing.lostFocusedBlock = false
      loseFocusUnlessReplaced()
      return
    }
    if let index = focusedIndex() {
      collectionView.layoutIfNeeded()
      remeasure(index)
    }
  }

  /// The focused block went away. A structural command sends the new caret in the patch right after, so wait a moment
  /// for it before dismissing the keyboard.
  private func loseFocusUnlessReplaced() {
    guard let lost = editing.focus else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
      guard let self, editing.focus == lost, index(of: lost.key).map({ self.items[$0].block.editableText(cell: lost.cell) == nil }) ?? true
      else { return }
      editing.focus = nil
      blurDocument()
    }
  }

  private func select(_ anchor: TextPoint, _ head: TextPoint) {
    editing.lostFocusedBlock = false
    guard editing.editable else { return }
    guard head.block >= 0, head.block < items.count, items[head.block].block.editableText(cell: head.cell) != nil else {
      editing.focus = nil
      return blurDocument()
    }
    let sameBlock = anchor.block == head.block && anchor.cell == head.cell
    let from = sameBlock ? min(anchor.offset, head.offset) : head.offset
    let to = sameBlock ? max(anchor.offset, head.offset) : head.offset
    let range = NSRange(location: from, length: to - from)
    focus(Focus(key: items[head.block].key, cell: head.cell), at: head.block, caret: .range(range), fromModel: true)
  }

  // MARK: Input

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    let point = gesture.location(in: collectionView)
    guard let indexPath = collectionView.indexPathForItem(at: point), indexPath.item < items.count,
      let cell = collectionView.cellForItem(at: indexPath) as? BlockCell
    else { return }
    let item = items[indexPath.item]
    let local = cell.convert(point, from: collectionView)
    if cell.isCheckbox(at: local) {
      send(.taskToggle, ["block": indexPath.item])
      return
    }
    var tableCell: TableCellIndex?
    if case .table = item.block.body {
      guard let hit = (cell as? TableCell)?.tableCell(at: local) else { return }
      tableCell = hit
    }
    guard item.block.editableText(cell: tableCell) != nil else { return blurDocument() }
    focus(Focus(key: item.key, cell: tableCell), at: indexPath.item, caret: .point(point))
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    !(editing.hasEditor && touch.view?.isDescendant(of: editing.editor) == true)
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
  ) -> Bool { true }

  private func press(_ key: StructuralKey, shift: Bool) {
    guard editing.focus != nil else { return }
    sendText()
    reportSelection()
    editing.eventCount += 1
    send(.key, ["eventCount": editing.eventCount, "key": key.rawValue, "shift": shift])
  }

  private func point(_ offset: Int) -> TextPoint? {
    guard let index = focusedIndex() else { return nil }
    return TextPoint(block: index, cell: editing.focus?.cell, offset: offset)
  }

  /// Sends what changed in the focused text since the model last heard, as one replacement.
  private func sendText() {
    guard let place = point(0) else { return }
    let now = NSString(string: editing.editor.textStorage.string)
    guard let diff = TextDiff.between(editing.shown, now, caret: editing.editor.selectedRange.upperBound) else { return }
    editing.shown = now
    editing.eventCount += 1
    var payload = place.payload
    payload.removeValue(forKey: "offset")
    payload.merge(["eventCount": editing.eventCount, "from": diff.from, "to": diff.to, "text": diff.text]) { $1 }
    send(.edit, payload)
    if let selection = editing.modelSelection {
      let start = diff.map(selection.location)
      editing.modelSelection = NSRange(location: start, length: max(0, diff.map(selection.upperBound) - start))
    }
  }

  private func reportSelection(force: Bool = false) {
    let range = editing.editor.selectedRange
    guard force || range != editing.modelSelection, let anchor = point(range.location), let head = point(range.upperBound)
    else { return }
    editing.modelSelection = range
    send(.select, ["anchor": anchor.payload, "head": head.payload])
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    send(.focus)
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    sendText()
    flushHeldPatches()
    unfocus()
    send(.blur)
  }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    guard text == "\n", textView.markedTextRange == nil else { return true }
    press(.enter, shift: false)
    return false
  }

  func textViewDidChange(_ textView: UITextView) {
    sendText()
    flushHeldPatches()
    if let index = focusedIndex() {
      remeasure(index)
      collectionView.layoutIfNeeded()
    }
    revealCaret()
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    guard !editing.applyingModel, editing.focus != nil else { return }
    sendText()
    reportSelection()
    flushHeldPatches()
    revealCaret()
  }

  @available(iOS 16.0, *)
  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    guard !editing.formatActions.isEmpty else { return nil }
    let format = editing.formatActions.map { action in
      UIAction(title: action.label) { [weak self] _ in
        guard let self else { return }
        sendText()
        reportSelection(force: true)
        send(.format, ["action": action.id])
      }
    }
    return UIMenu(children: suggestedActions + [UIMenu(options: .displayInline, children: format)])
  }

  // MARK: Keeping the caret visible

  @objc private func keyboardWillChangeFrame(_ notification: Notification) {
    guard let end = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect, window != nil else {
      return
    }
    let keyboard = collectionView.convert(end, from: nil)
    editing.keyboardOverlap = max(0, collectionView.bounds.maxY - keyboard.minY)
    revealCaret()
  }

  @objc private func keyboardWillHide(_ notification: Notification) {
    editing.keyboardOverlap = 0
  }

  func revealCaret() {
    guard isEditing, let range = editing.editor.selectedTextRange else { return }
    let editor = editing.editor
    let caret = editor.convert(editor.caretRect(for: range.end), to: collectionView)
    guard caret.height > 0, !caret.isInfinite, !caret.isNull else { return }
    let margin: CGFloat = 16
    let inset = collectionView.contentInset
    let bottomInset = max(inset.bottom, editing.keyboardOverlap)
    let visibleTop = collectionView.contentOffset.y + inset.top
    let visibleBottom = collectionView.contentOffset.y + collectionView.bounds.height - bottomInset
    var offset = collectionView.contentOffset.y
    if caret.maxY + margin > visibleBottom {
      offset += caret.maxY + margin - visibleBottom
    } else if caret.minY - margin < visibleTop {
      offset -= visibleTop - (caret.minY - margin)
    } else {
      return
    }
    let highest = max(-inset.top, collectionView.contentSize.height + bottomInset - collectionView.bounds.height)
    collectionView.contentOffset.y = min(max(offset, -inset.top), highest)
  }
}

private func clamp(_ range: NSRange, to length: Int) -> NSRange {
  let location = min(max(0, range.location), length)
  return NSRange(location: location, length: min(max(0, range.length), length - location))
}
