package dev.hinacode.documentview

import android.annotation.SuppressLint
import android.content.Context
import android.view.View
import android.view.inputmethod.InputMethodManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.text.BreakIterator
import kotlin.math.roundToInt

private val CAPABILITIES = listOf(
  Capability.RENDER,
  Capability.TASK_TOGGLE,
  Capability.CHARTS,
  Capability.IMAGES,
  Capability.HIGHLIGHT,
  Capability.DIAGRAMS,
)

private class TextPoint(val block: Int, val cell: Cell?, val offset: Int)

private class Patch(
  val start: Int,
  val deleteCount: Int,
  val insert: List<Block>,
  val eventCount: Int,
  val anchor: TextPoint?,
  val head: TextPoint?,
)

private class PendingSelection(val anchor: Int, val head: Int, val report: Boolean)

private fun JSONObject.toPoint(): TextPoint {
  val cell = optJSONArray("cell")?.let { it.optInt(0) to it.optInt(1) }
  return TextPoint(optInt("block"), cell, optInt("offset"))
}

private fun Block.textAt(cell: Cell?): String? = when (val body = body) {
  is Body.Paragraph -> body.runs.joinToString("") { it.text }.takeIf { cell == null }
  is Body.Heading -> body.runs.joinToString("") { it.text }.takeIf { cell == null }
  is Body.Code -> body.text.takeIf { cell == null }
  is Body.Chart -> body.source.takeIf { cell == null }
  is Body.Diagram -> body.source.takeIf { cell == null }
  is Body.Table -> cell?.let { (row, column) -> body.rows.getOrNull(row)?.getOrNull(column)?.joinToString("") { it.text } }
  else -> null
}

private fun wordAround(text: String, offset: Int): Pair<Int, Int> {
  if (text.isEmpty()) return 0 to 0
  val words = BreakIterator.getWordInstance()
  words.setText(text)
  val at = offset.coerceIn(0, text.length)
  val end = words.following(at.coerceAtMost(text.length - 1)).takeIf { it != BreakIterator.DONE } ?: text.length
  val start = words.preceding(end).takeIf { it != BreakIterator.DONE } ?: 0
  return start to end
}

@SuppressLint("ViewConstructor")
class DocumentView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onDocumentEvent by EventDispatcher<Map<String, Any?>>()
  private val density = resources.displayMetrics.density

  var editable = false
    set(value) {
      if (field == value) return
      field = value
      if (!value) endEditing()
    }
  private var formatActions: List<FormatAction> = emptyList()
  private var themeJson = ""
  private var insetTop = 0f
  private var insetBottom = 0f
  private var announced = false
  private var reportedHeight = -1

  private var eventCount = 0
  private var focusPatchCount = 0
  private var generation = 0
  private var editing = false
  private var reportedFocus = false
  private var activeEditor: BlockEditText? = null
  private var pendingSelection: PendingSelection? = null
  private var lastFocus: Focus? = null
  private val held = ArrayDeque<Patch>()

  private val images: Images = Images(
    maxWidth = { width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels },
    request = { src -> send(NativeEventType.IMAGE_REQUEST, "src" to src) },
    changed = { src -> adapter.imageChanged(src) },
  )

  private val editorListener = object : EditorListener {
    override val formatActions get() = this@DocumentView.formatActions

    override fun edited(editor: BlockEditText, from: Int, to: Int, text: String) {
      val focus = adapter.focus?.takeIf { editor === activeEditor } ?: return
      eventCount++
      send(
        NativeEventType.EDIT,
        "eventCount" to eventCount,
        "block" to focus.index,
        "cell" to focus.cell?.toList(),
        "from" to from,
        "to" to to,
        "text" to text,
      )
    }

    override fun selected(editor: BlockEditText) {
      val focus = adapter.focus?.takeIf { editor === activeEditor } ?: return
      send(
        NativeEventType.SELECT,
        "anchor" to point(focus, editor.selectionStart),
        "head" to point(focus, editor.selectionEnd),
      )
    }

    override fun key(editor: BlockEditText, key: StructuralKey, shift: Boolean) {
      if (editor !== activeEditor) return
      eventCount++
      send(NativeEventType.KEY, "eventCount" to eventCount, "key" to key.wire, "shift" to shift)
    }

    override fun inputSettled(editor: BlockEditText) {
      if (held.isNotEmpty()) post { drain() }
    }

    override fun focusChanged(editor: BlockEditText, focused: Boolean) {
      if (focused) {
        if (!reportedFocus) {
          reportedFocus = true
          send(NativeEventType.FOCUS)
        }
        return
      }
      post { if (editor === activeEditor && editor.isAttachedToWindow && !editor.hasFocus() && !focusInside()) endEditing() }
    }

    override fun format(editor: BlockEditText, action: String) {
      selected(editor)
      send(NativeEventType.FORMAT, "action" to action)
    }
  }

  private val adapter: BlockAdapter = BlockAdapter(object : Host {
    override val images get() = this@DocumentView.images
    override val editable get() = this@DocumentView.editable
    override val editorListener get() = this@DocumentView.editorListener

    override fun link(href: String) = send(NativeEventType.LINK_PRESS, "href" to href)

    override fun tap(view: View, cell: Cell?, offset: Int, long: Boolean) {
      val index = positionOf(view) ?: return
      val text = adapter.blocks[index].textAt(cell) ?: return
      editing = true
      val (anchor, head) = if (long) wordAround(text, offset) else offset to offset
      focusOn(Focus(index, cell), PendingSelection(anchor, head, report = true))
    }

    override fun editorBound(editor: BlockEditText, styled: CharSequence) = bound(editor, styled)

    override fun taskToggle(view: View) {
      val index = positionOf(view) ?: return
      send(NativeEventType.TASK_TOGGLE, "block" to index)
    }
  })

  private val layoutManager = LinearLayoutManager(context)

  private val list = RecyclerView(context).apply {
    layoutManager = this@DocumentView.layoutManager
    adapter = this@DocumentView.adapter
    itemAnimator = null
    clipToPadding = false
    isFocusableInTouchMode = false
    recycledViewPool.setMaxRecycledViews(RowKind.TEXT.ordinal, 24)
    addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reportContentSize() }
    addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) reportContentSize()
      }
    })
  }

  init {
    addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (announced) return
    announced = true
    post { send(NativeEventType.READY, "capabilities" to CAPABILITIES.map { it.wire }) }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (editing) post { revealCaret() }
  }

  @SuppressLint("NotifyDataSetChanged")
  fun setTheme(json: String) {
    if (json == themeJson) return
    themeJson = json
    adapter.theme = runCatching { DocumentTheme.parse(json) }.getOrElse {
      send(NativeEventType.ERROR, "message" to "theme: ${it.message}")
      DocumentTheme()
    }
    if (adapter.itemCount > 0) adapter.notifyDataSetChanged()
  }

  fun setFormatActions(json: String) {
    formatActions = runCatching {
      val parsed = JSONArray(json)
      (0 until parsed.length()).map { parsed.getJSONObject(it).let { action -> FormatAction(action.getString("id"), action.getString("label")) } }
    }.getOrDefault(emptyList())
  }

  fun setContentInset(top: Float = insetTop, bottom: Float = insetBottom) {
    insetTop = top
    insetBottom = bottom
    list.setPadding(0, (top * density).roundToInt(), 0, (bottom * density).roundToInt())
    if (editing) post { revealCaret() }
  }

  fun applyPatch(json: String) {
    try {
      val patch = JSONObject(json)
      val insert = patch.optJSONArray("insert")
      val selection = patch.optJSONObject("selection")
      held.addLast(
        Patch(
          start = patch.optInt("start"),
          deleteCount = patch.optInt("deleteCount"),
          insert = (0 until (insert?.length() ?: 0)).mapNotNull { insert!!.optJSONObject(it)?.toBlock() },
          eventCount = patch.optInt("eventCount"),
          anchor = selection?.optJSONObject("anchor")?.toPoint(),
          head = selection?.optJSONObject("head")?.toPoint(),
        ),
      )
      drain()
    } catch (error: Exception) {
      send(NativeEventType.ERROR, "message" to "patch: ${error.message}")
    }
  }

  fun scrollToBlock(index: Int) {
    if (index in 0 until adapter.itemCount) layoutManager.scrollToPositionWithOffset(index, 0)
  }

  fun provideImage(src: String, dataUrl: String) = images.provide(src, dataUrl)

  fun focus() {
    if (!editable) return
    val target = lastFocus?.takeIf { adapter.blocks.getOrNull(it.index)?.textAt(it.cell) != null }
      ?: adapter.blocks.indexOfFirst { it.body.editsAsText() }.takeIf { it >= 0 }?.let { Focus(it, null) }
      ?: return
    editing = true
    val editor = activeEditor
    if (editor != null && adapter.focus == target) return showKeyboard(editor)
    focusOn(target, pendingSelection ?: PendingSelection(0, 0, report = true))
  }

  fun blur() = endEditing()

  fun release() = images.release()

  /** Applies patches in order, holding the queue while the head would replace the focused block mid-composition. */
  private fun drain() {
    while (held.isNotEmpty()) {
      val patch = held.first()
      if (activeEditor?.composing == true && touchesFocus(patch)) return
      held.removeFirst()
      apply(patch)
    }
    post { reportContentSize() }
  }

  private fun touchesFocus(patch: Patch): Boolean {
    val focus = adapter.focus ?: return false
    return patch.head != null || (patch.deleteCount > 0 && focus.index in patch.start until patch.start + patch.deleteCount)
  }

  private fun apply(patch: Patch) {
    val start = patch.start.coerceIn(0, adapter.blocks.size)
    val deleteCount = patch.deleteCount.coerceIn(0, adapter.blocks.size - start)
    var keep: Int? = null
    val focus = adapter.focus
    if (focus != null && (deleteCount > 0 || patch.insert.isNotEmpty())) {
      val end = start + deleteCount
      if (focus.index >= end) {
        adapter.focus = focus.copy(index = focus.index + patch.insert.size - deleteCount)
      } else if (focus.index >= start) {
        val relative = focus.index - start
        if (patch.insert.getOrNull(relative)?.textAt(focus.cell) != null) {
          keep = relative
          focusPatchCount = patch.eventCount
        } else {
          dropFocus()
        }
      }
    }
    adapter.splice(start, deleteCount, patch.insert, keep)
    val head = patch.head ?: return
    val anchor = patch.anchor ?: head
    val target = adapter.blocks.getOrNull(head.block)?.takeIf { it.textAt(head.cell) != null }
    if (target == null) return endEditing()
    val sameText = anchor.block == head.block && anchor.cell == head.cell
    val selection = PendingSelection(if (sameText) anchor.offset else head.offset, head.offset, report = false)
    if (editing) {
      focusOn(Focus(head.block, head.cell), selection)
    } else {
      lastFocus = Focus(head.block, head.cell)
      pendingSelection = selection
    }
  }

  private fun focusOn(target: Focus, selection: PendingSelection) {
    val current = adapter.focus
    val editor = activeEditor
    lastFocus = target
    if (current == target && editor != null && editor.isAttachedToWindow) {
      editor.select(selection.anchor, selection.head)
      if (selection.report) editorListener.selected(editor)
      if (!editor.hasFocus()) editor.post { claimFocus(editor) }
      post { revealCaret() }
      return
    }
    pendingSelection = selection
    if (current != target) {
      generation++
      activeEditor = null
      adapter.focus = target
      current?.let { adapter.notifyItemChanged(it.index) }
    }
    adapter.notifyItemChanged(target.index)
    if (list.findViewHolderForAdapterPosition(target.index) == null) layoutManager.scrollToPosition(target.index)
  }

  private fun bound(editor: BlockEditText, styled: CharSequence) {
    if (editor.generation == generation) {
      editor.present(styled, replace = focusPatchCount >= eventCount && !editor.composing)
    } else {
      editor.load(styled)
      editor.generation = generation
    }
    activeEditor = editor
    pendingSelection?.let { selection ->
      pendingSelection = null
      editor.select(selection.anchor, selection.head)
      if (selection.report) editor.post { editorListener.selected(editor) }
    }
    if (editing && !editor.hasFocus()) editor.post { claimFocus(editor) }
  }

  private fun claimFocus(editor: BlockEditText) {
    if (editor !== activeEditor || !editing) return
    editor.requestFocus()
    showKeyboard(editor)
    post { revealCaret() }
  }

  private fun showKeyboard(editor: BlockEditText) {
    val keyboard = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    keyboard.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
  }

  /** The focused block went away without a new caret, for example when another device deleted it. */
  private fun dropFocus() {
    lastFocus = adapter.focus
    adapter.focus = null
    activeEditor = null
    generation++
  }

  private fun endEditing() {
    val editor = activeEditor
    val focus = adapter.focus
    editing = false
    if (focus != null) {
      dropFocus()
      adapter.notifyItemChanged(focus.index)
    }
    if (editor != null) {
      val keyboard = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
      keyboard.hideSoftInputFromWindow(editor.windowToken, 0)
      editor.clearFocus()
    }
    if (reportedFocus) {
      reportedFocus = false
      send(NativeEventType.BLUR)
    }
  }

  private fun focusInside(): Boolean {
    var view: View? = rootView.findFocus() ?: return false
    while (view != null) {
      if (view === this) return true
      view = view.parent as? View
    }
    return false
  }

  private fun revealCaret() {
    val editor = activeEditor?.takeIf { it.isAttachedToWindow && it.hasFocus() } ?: return
    val caret = editor.caretRect() ?: return
    caret.inset(0, -(8 * density).roundToInt())
    editor.requestRectangleOnScreen(caret, false)
  }

  private fun positionOf(view: View): Int? =
    list.findContainingViewHolder(view)?.bindingAdapterPosition?.takeIf { it != RecyclerView.NO_POSITION }

  private fun point(focus: Focus, offset: Int) =
    mapOf("block" to focus.index, "cell" to focus.cell?.toList(), "offset" to offset)

  private fun reportContentSize() {
    val height = (list.computeVerticalScrollRange() / density + insetTop + insetBottom).roundToInt()
    if (height == reportedHeight) return
    reportedHeight = height
    send(NativeEventType.CONTENT_SIZE, "height" to height)
  }

  private fun send(type: NativeEventType, vararg fields: Pair<String, Any?>) =
    onDocumentEvent(mapOf("type" to type.wire, *fields))
}
