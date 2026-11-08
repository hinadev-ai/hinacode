package dev.hinacode.composereditor

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject

private data class Theme(
  val text: Int = Color.BLACK,
  val placeholder: Int = Color.GRAY,
  val token: Int = Color.BLUE,
  val tokenBackground: Int = Color.TRANSPARENT,
  val codeBackground: Int = Color.LTGRAY,
  val muted: Int = Color.GRAY,
  val link: Int = Color.BLUE,
  val caret: Int = Color.BLACK,
)

private fun JSONObject.color(key: String, fallback: Int) =
  optString(key).takeIf { it.isNotEmpty() }?.let { parseCssColor(it) } ?: fallback

/** Theme colors come from the app's palette, which uses `#rrggbb` and `rgba(r, g, b, a)`. */
internal fun parseCssColor(css: String): Int? {
  val rgba = Regex("""rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)""").matchEntire(css.trim())
  if (rgba != null) {
    val (r, g, b) = rgba.destructured
    val alpha = rgba.groupValues[4].ifEmpty { "1" }.toFloat()
    return Color.argb((alpha * 255).toInt(), r.toFloat().toInt(), g.toFloat().toInt(), b.toFloat().toInt())
  }
  return runCatching { Color.parseColor(css.trim()) }.getOrNull()
}

private const val FORMAT_ITEM = 0x4843

@SuppressLint("ViewConstructor")
class ComposerEditorView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onEditorChange by EventDispatcher()
  private val onEditorSelection by EventDispatcher()
  private val onEditorFocus by EventDispatcher()
  private val onEditorBlur by EventDispatcher()
  private val onEditorContentSize by EventDispatcher()
  private val onEditorFormat by EventDispatcher()

  private var theme = Theme()
  private var icons: Map<String, ChipIcon> = emptyMap()
  private var document: JSONObject? = null
  private var eventCount = 0
  private var applying = false
  private var contentHeight = -1
  private var requestedSelection: Pair<Int, Int>? = null
  private var formatActions: List<Pair<String, String>> = emptyList()

  val editor: DecoratedEditText = DecoratedEditText(context).apply {
    background = null
    gravity = Gravity.TOP or Gravity.START
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    setPadding(0, 0, 0, 0)
    isVerticalScrollBarEnabled = true
    onSelection = { start, end -> if (!applying) onEditorSelection(mapOf("start" to start, "end" to end)) }
    setOnFocusChangeListener { _, focused -> if (focused) onEditorFocus(mapOf()) else onEditorBlur(mapOf()) }
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit

      override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) = Unit

      override fun afterTextChanged(editable: Editable) {
        if (applying) return
        eventCount++
        onEditorChange(
          mapOf(
            "text" to editable.toString(),
            "start" to selectionStart,
            "end" to selectionEnd,
            "eventCount" to eventCount,
          ),
        )
      }
    })
    viewTreeObserver.addOnPreDrawListener {
      reportContentHeight()
      true
    }
  }

  init {
    addView(editor, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  private fun dp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

  private fun sp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)

  /**
   * Takes the text and decorations JS rendered. A document that has not seen the editor's latest edit is stale,
   * so it changes nothing: the next render carries both the edit and decorations for it.
   */
  fun setDocument(json: String) {
    val next = JSONObject(json)
    document = next
    if (next.optInt("eventCount") < eventCount) return
    val value = next.optString("value")
    val editable = editor.text ?: return
    if (editable.toString() != value) withoutEvents { replaceChanged(editable, value) }
    applyDecorations()
    val selection = next.optJSONObject("selection")?.let { it.optInt("start") to it.optInt("end") }
    if (selection != requestedSelection) {
      requestedSelection = selection
      if (selection != null) select(selection.first, selection.second)
    }
  }

  fun setFormatActions(json: String) {
    val parsed = JSONArray(json)
    formatActions = (0 until parsed.length()).map { parsed.getJSONObject(it).let { action -> action.getString("id") to action.getString("label") } }
    editor.customSelectionActionModeCallback = if (formatActions.isEmpty()) null else formatMenu
  }

  private val formatMenu = object : android.view.ActionMode.Callback {
    override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu): Boolean {
      formatActions.forEachIndexed { index, (_, label) -> menu.add(android.view.Menu.NONE, FORMAT_ITEM + index, 100 + index, label) }
      return true
    }

    override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = false

    override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem): Boolean {
      val action = formatActions.getOrNull(item.itemId - FORMAT_ITEM) ?: return false
      onEditorFormat(mapOf("action" to action.first, "start" to editor.selectionStart, "end" to editor.selectionEnd))
      withoutEvents { mode.finish() }
      return true
    }

    override fun onDestroyActionMode(mode: android.view.ActionMode) = Unit
  }

  fun setIcons(json: String) {
    val parsed = JSONObject(json)
    icons = parsed.keys().asSequence().associateWith { name ->
      val paths = parsed.getJSONArray(name)
      ChipIcon((0 until paths.length()).map { paths.getJSONObject(it).let { path -> path.getString("d") to path.optBoolean("fill") } })
    }
    applyDecorations()
  }

  fun setTheme(json: String) {
    val parsed = JSONObject(json)
    val fallback = Theme()
    theme = Theme(
      text = parsed.color("text", fallback.text),
      placeholder = parsed.color("placeholder", fallback.placeholder),
      token = parsed.color("token", fallback.token),
      tokenBackground = parsed.color("tokenBackground", fallback.tokenBackground),
      codeBackground = parsed.color("codeBackground", fallback.codeBackground),
      muted = parsed.color("muted", fallback.muted),
      link = parsed.color("link", fallback.link),
      caret = parsed.color("caret", fallback.caret),
    )
    editor.setTextColor(theme.text)
    editor.setHintTextColor(theme.placeholder)
    editor.highlightColor = (theme.caret and 0x00ffffff) or 0x40000000
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) editor.textCursorDrawable?.setTint(theme.caret)
    applyDecorations()
  }

  fun setFontSize(size: Float) = editor.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)

  fun setLineHeight(height: Float) {
    if (height > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) editor.lineHeight = sp(height).toInt()
  }

  fun setPadding(horizontal: Float? = null, vertical: Float? = null) {
    val x = horizontal?.let { dp(it).toInt() } ?: editor.paddingLeft
    val y = vertical?.let { dp(it).toInt() } ?: editor.paddingTop
    editor.setPadding(x, y, x, y)
  }

  fun setEditable(editable: Boolean) {
    editor.isFocusable = editable
    editor.isFocusableInTouchMode = editable
    editor.isCursorVisible = editable
  }

  fun focus() {
    editor.requestFocus()
    val keyboard = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
    keyboard.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
  }

  fun select(start: Int, end: Int) {
    val length = editor.text?.length ?: 0
    withoutEvents { editor.setSelection(start.coerceIn(0, length), end.coerceIn(0, length)) }
  }

  private inline fun withoutEvents(block: () -> Unit) {
    applying = true
    try {
      block()
    } finally {
      applying = false
    }
  }

  /** Replaces only the part that differs, so spans, the caret and the keyboard's composition outside it survive. */
  private fun replaceChanged(editable: Editable, value: String) {
    val current = editable.toString()
    var prefix = 0
    while (prefix < current.length && prefix < value.length && current[prefix] == value[prefix]) prefix++
    var suffix = 0
    while (
      suffix < current.length - prefix &&
      suffix < value.length - prefix &&
      current[current.length - 1 - suffix] == value[value.length - 1 - suffix]
    ) suffix++
    editable.replace(prefix, current.length - suffix, value, prefix, value.length - suffix)
  }

  private fun applyDecorations() {
    val editable = editor.text ?: return
    val decorations = document?.takeIf { it.optString("value") == editable.toString() }?.optJSONArray("decorations") ?: return
    withoutEvents {
      editable.getSpans(0, editable.length, Decoration::class.java).forEach(editable::removeSpan)
      for (index in 0 until decorations.length()) addDecoration(editable, decorations.getJSONObject(index))
    }
    editor.invalidate()
  }

  private fun addDecoration(editable: Editable, decoration: JSONObject) {
    val start = decoration.optInt("start").coerceIn(0, editable.length)
    val end = decoration.optInt("end").coerceIn(start, editable.length)
    if (start == end) return
    val flags = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
    when (decoration.optString("kind")) {
      "token" -> editable.setSpan(TokenColorSpan(theme.token), start, end, flags)
      "muted" -> editable.setSpan(TokenColorSpan(theme.muted), start, end, flags)
      "code" -> editable.setSpan(CodeBackgroundSpan(theme.codeBackground), start, end, flags)
      "chip" -> {
        editable.setSpan(ChipSpan(theme.tokenBackground), start, end, flags)
        editable.setSpan(TokenColorSpan(theme.token), start, end, flags)
        val icon = icons[decoration.optString("icon")]
        if (icon != null) editable.setSpan(ChipIconSpan(icon, theme.token), start, start + 1, flags)
      }
      "strong" -> editable.setSpan(FontStyleSpan.bold, start, end, flags)
      "emphasis" -> editable.setSpan(FontStyleSpan.italic, start, end, flags)
      "link" -> {
        editable.setSpan(TokenColorSpan(theme.link), start, end, flags)
        editable.setSpan(LinkUnderlineSpan(), start, end, flags)
      }
    }
  }

  private fun reportContentHeight() {
    val layout = editor.layout ?: return
    val height = layout.height + editor.compoundPaddingTop + editor.compoundPaddingBottom
    if (height == contentHeight) return
    contentHeight = height
    onEditorContentSize(mapOf("height" to height / resources.displayMetrics.density))
  }
}

/** An EditText that paints chip pills under its text and reports selection moves. */
class DecoratedEditText(context: Context) : EditText(context) {
  internal var onSelection: ((Int, Int) -> Unit)? = null
  private val pill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val bounds = RectF()
  private val radius = 4 * resources.displayMetrics.density
  private val inset = 2 * resources.displayMetrics.density

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    onSelection?.invoke(selStart, selEnd)
  }

  override fun onDraw(canvas: Canvas) {
    val text = text
    val layout = layout
    if (text != null && layout != null) {
      val metrics = paint.fontMetrics
      canvas.save()
      canvas.translate(compoundPaddingLeft.toFloat(), extendedPaddingTop.toFloat())
      for (chip in text.getSpans(0, text.length, ChipSpan::class.java)) {
        val start = text.getSpanStart(chip)
        val end = text.getSpanEnd(chip)
        pill.color = chip.background
        val firstLine = layout.getLineForOffset(start)
        val lastLine = layout.getLineForOffset(end)
        for (line in firstLine..lastLine) {
          val left = if (line == firstLine) layout.getPrimaryHorizontal(start) else layout.getLineLeft(line)
          val right = if (line == lastLine) layout.getPrimaryHorizontal(end) else layout.getLineRight(line)
          if (right <= left) continue
          val baseline = layout.getLineBaseline(line).toFloat()
          bounds.set(left - inset, baseline + metrics.ascent, right + inset, baseline + metrics.descent)
          canvas.drawRoundRect(bounds, radius, radius, pill)
        }
      }
      canvas.restore()
    }
    super.onDraw(canvas)
  }
}
