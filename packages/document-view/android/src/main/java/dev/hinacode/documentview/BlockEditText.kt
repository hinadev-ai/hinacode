package dev.hinacode.documentview

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.EditText
import kotlin.math.min

internal enum class StructuralKey(val wire: String) { ENTER("Enter"), BACKSPACE("Backspace"), DELETE("Delete"), TAB("Tab") }

internal class FormatAction(val id: String, val label: String)

internal interface EditorListener {
  fun edited(editor: BlockEditText, from: Int, to: Int, text: String)

  fun selected(editor: BlockEditText)

  fun key(editor: BlockEditText, key: StructuralKey, shift: Boolean)

  fun inputSettled(editor: BlockEditText)

  fun focusChanged(editor: BlockEditText, focused: Boolean)

  fun format(editor: BlockEditText, action: String)

  val formatActions: List<FormatAction>
}

internal class TextChange(val from: Int, val to: Int, val text: String)

/**
 * The common prefix and suffix of two strings in UTF-16 units, never splitting a surrogate pair. [caret] is where the
 * change ended in [after]; the suffix stops there, so typing "a" into "a|a" is reported at the caret, not at the end.
 */
internal fun textChange(before: String, after: String, caret: Int = after.length): TextChange {
  val shorter = min(before.length, after.length)
  var suffix = 0
  val suffixLimit = min(shorter, after.length - caret.coerceIn(0, after.length))
  while (suffix < suffixLimit && before[before.length - 1 - suffix] == after[after.length - 1 - suffix]) suffix++
  if (suffix > 0 && Character.isLowSurrogate(after[after.length - suffix])) suffix--
  var prefix = 0
  while (prefix < shorter - suffix && before[prefix] == after[prefix]) prefix++
  if (prefix > 0 && Character.isHighSurrogate(after[prefix - 1])) prefix--
  return TextChange(prefix, before.length - suffix, after.substring(prefix, after.length - suffix))
}

private const val FORMAT_GROUP = 0x4844

/**
 * The focused block's text view. It owns its text while the user types: every change is reported once, diffed, and
 * Enter, Backspace and Delete at the block's edges, and Tab, become structural keys the model handles.
 */
@SuppressLint("ViewConstructor")
internal class BlockEditText(context: Context, private val listener: EditorListener) : EditText(context) {
  var generation = -1
  private var shown = ""
  private var applying = false
  private var changing = 0
  private var selectionPending = false
  private var styleSpans: List<Any> = emptyList()

  init {
    background = null
    setPadding(0, 0, 0, 0)
    includeFontPadding = false
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) {
        changing++
      }

      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit

      override fun afterTextChanged(editable: Editable) {
        changing--
        textChanged(editable.toString())
      }
    })
    setOnFocusChangeListener { _, focused -> listener.focusChanged(this, focused) }
    customSelectionActionModeCallback = FormatMenu()
  }

  val composing: Boolean
    get() {
      val text = text ?: return false
      return BaseInputConnection.getComposingSpanStart(text) in 0 until BaseInputConnection.getComposingSpanEnd(text)
    }

  val caretAtStart get() = selectionStart == 0 && selectionEnd == 0 && !composing

  val caretAtEnd get() = selectionStart == length() && selectionEnd == length() && !composing

  /** Shows a block this view did not show before. */
  fun load(styled: CharSequence) = quietly {
    setText(styled.toString())
    styleSpans = emptyList()
    restyle(styled)
  }

  /**
   * Shows the model's version of the block this view already shows. Equal text keeps the caret and the composition and
   * only takes the new styling. Different text replaces only what differs, and only when [replace] allows it.
   */
  fun present(styled: CharSequence, replace: Boolean) {
    val target = styled.toString()
    val editable = text ?: return
    if (target != editable.toString()) {
      if (!replace) return
      quietly {
        val change = textChange(editable.toString(), target)
        editable.replace(change.from, change.to, change.text)
      }
    }
    quietly { restyle(styled) }
  }

  fun select(anchor: Int, head: Int) = quietly {
    val length = length()
    setSelection(anchor.coerceIn(0, length), head.coerceIn(0, length))
  }

  fun caretRect(): Rect? {
    val layout = layout ?: return null
    val offset = selectionEnd.coerceAtLeast(0)
    val line = layout.getLineForOffset(offset)
    val x = layout.getPrimaryHorizontal(offset).toInt() + totalPaddingLeft - scrollX
    val top = layout.getLineTop(line) + totalPaddingTop
    val bottom = layout.getLineBottom(line) + totalPaddingTop
    return Rect(x - 1, top, x + 1, bottom)
  }

  private fun restyle(styled: CharSequence) {
    val editable = text ?: return
    for (span in styleSpans) editable.removeSpan(span)
    val spanned = styled as? Spanned ?: return run { styleSpans = emptyList() }
    styleSpans = spanned.getSpans(0, spanned.length, Any::class.java).toList()
    for (span in styleSpans) {
      val start = spanned.getSpanStart(span).coerceIn(0, editable.length)
      val end = spanned.getSpanEnd(span).coerceIn(start, editable.length)
      editable.setSpan(span, start, end, spanned.getSpanFlags(span))
    }
  }

  private inline fun quietly(block: () -> Unit) {
    val nested = applying
    applying = true
    try {
      block()
    } finally {
      applying = nested
      shown = text?.toString().orEmpty()
    }
  }

  private fun textChanged(now: String) {
    if (applying) {
      shown = now
      return
    }
    if (now != shown) {
      val change = textChange(shown, now, selectionEnd)
      shown = now
      listener.edited(this, change.from, change.to, change.text)
    }
    if (changing == 0 && selectionPending) {
      selectionPending = false
      listener.selected(this)
    }
  }

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    @Suppress("SENSELESS_COMPARISON")
    if (listener == null || applying) return
    if (changing > 0) selectionPending = true else listener.selected(this)
  }

  private fun structural(key: StructuralKey, shift: Boolean) = listener.key(this, key, shift)

  /** Hardware keys and the keys an IME sends with sendKeyEvent both arrive here. */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val down = event.action == KeyEvent.ACTION_DOWN
    val key = when (event.keyCode) {
      KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> StructuralKey.ENTER
      KeyEvent.KEYCODE_TAB -> StructuralKey.TAB
      KeyEvent.KEYCODE_DEL -> StructuralKey.BACKSPACE.takeIf { caretAtStart }
      KeyEvent.KEYCODE_FORWARD_DEL -> StructuralKey.DELETE.takeIf { caretAtEnd }
      KeyEvent.KEYCODE_Z, KeyEvent.KEYCODE_Y -> if (event.isCtrlPressed) return true else null
      else -> null
    } ?: return super.dispatchKeyEvent(event)
    if (down) structural(key, event.isShiftPressed)
    return true
  }

  override fun onTextContextMenuItem(id: Int): Boolean = when (id) {
    android.R.id.undo, android.R.id.redo -> true
    android.R.id.paste -> super.onTextContextMenuItem(android.R.id.pasteAsPlainText)
    else -> super.onTextContextMenuItem(id)
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? =
    super.onCreateInputConnection(outAttrs)?.let(::Connection)

  /** Catches the forms GBoard and other IMEs use for Enter and for Backspace at the start of the block. */
  private inner class Connection(target: InputConnection) : InputConnectionWrapper(target, true) {
    private fun settled(result: Boolean): Boolean {
      listener.inputSettled(this@BlockEditText)
      return result
    }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
      if (text?.toString() == "\n") return settled(true).also { structural(StructuralKey.ENTER, false) }
      return settled(super.commitText(text, newCursorPosition))
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      if (beforeLength > 0 && afterLength == 0 && caretAtStart) return true.also { structural(StructuralKey.BACKSPACE, false) }
      if (afterLength > 0 && beforeLength == 0 && caretAtEnd) return true.also { structural(StructuralKey.DELETE, false) }
      return settled(super.deleteSurroundingText(beforeLength, afterLength))
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
      if (beforeLength > 0 && afterLength == 0 && caretAtStart) return true.also { structural(StructuralKey.BACKSPACE, false) }
      if (afterLength > 0 && beforeLength == 0 && caretAtEnd) return true.also { structural(StructuralKey.DELETE, false) }
      return settled(super.deleteSurroundingTextInCodePoints(beforeLength, afterLength))
    }

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int) =
      settled(super.setComposingText(text, newCursorPosition))

    override fun setComposingRegion(start: Int, end: Int) = settled(super.setComposingRegion(start, end))

    override fun finishComposingText() = settled(super.finishComposingText())

    override fun setSelection(start: Int, end: Int) = settled(super.setSelection(start, end))

    override fun endBatchEdit() = settled(super.endBatchEdit())
  }

  private inner class FormatMenu : ActionMode.Callback {
    override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
      listener.formatActions.forEachIndexed { index, action -> menu.add(FORMAT_GROUP, index, 100 + index, action.label) }
      return true
    }

    override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false

    override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
      if (item.groupId != FORMAT_GROUP) return false
      val action = listener.formatActions.getOrNull(item.itemId) ?: return false
      listener.format(this@BlockEditText, action.id)
      return true
    }

    override fun onDestroyActionMode(mode: ActionMode) = Unit
  }
}
