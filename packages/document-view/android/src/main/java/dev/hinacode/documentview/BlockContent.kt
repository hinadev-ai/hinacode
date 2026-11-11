package dev.hinacode.documentview

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.SpannableString
import android.text.Spanned
import android.text.InputType
import android.text.Layout
import android.text.TextDirectionHeuristics
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.widget.TextViewCompat
import kotlin.math.max
import kotlin.math.roundToInt

internal interface Host {
  val images: Images
  val editable: Boolean
  val editorListener: EditorListener

  fun link(href: String)

  /** A tap, or a long press, on a block that has no editor yet. [offset] is in the block's (or the cell's) text. */
  fun tap(view: View, cell: Cell?, offset: Int, long: Boolean)

  fun editorBound(editor: BlockEditText, styled: CharSequence)

  fun taskToggle(view: View)
}

internal enum class RowKind { TEXT, CODE, CHART, DIAGRAM, TABLE, IMAGE, RULE, EDIT_TEXT, EDIT_SOURCE }

internal fun Body.editsAsText() = this is Body.Paragraph || this is Body.Heading

internal fun Body.editsAsSource() = this is Body.Code || this is Body.Chart || this is Body.Diagram

internal fun Body.isEditable() = editsAsText() || editsAsSource() || this is Body.Table

internal fun rowKind(body: Body, focused: Boolean = false) = when {
  focused && body.editsAsText() -> RowKind.EDIT_TEXT
  focused && body.editsAsSource() -> RowKind.EDIT_SOURCE
  else -> readOnlyRowKind(body)
}

private fun readOnlyRowKind(body: Body) = when (body) {
  is Body.Paragraph, is Body.Heading, is Body.Unsupported -> RowKind.TEXT
  is Body.Code -> RowKind.CODE
  is Body.Diagram -> if (body.drawing == null) RowKind.CODE else RowKind.DIAGRAM
  is Body.Chart -> RowKind.CHART
  is Body.Table -> RowKind.TABLE
  is Body.Image -> RowKind.IMAGE
  Body.Rule -> RowKind.RULE
}

internal abstract class BlockContent(val view: View) {
  open val firstLine: TextView? = null
  open val isRtl: Boolean = false

  abstract fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?)

  companion object {
    fun create(context: Context, kind: RowKind, host: Host): BlockContent = when (kind) {
      RowKind.TEXT -> TextContent(TextView(context))
      RowKind.EDIT_TEXT -> TextContent(BlockEditText(context, host.editorListener))
      RowKind.CODE -> CodeContent(TextView(context))
      RowKind.EDIT_SOURCE -> CodeContent(BlockEditText(context, host.editorListener))
      RowKind.CHART -> ChartContent(context)
      RowKind.DIAGRAM -> DiagramContent(context)
      RowKind.TABLE -> TableContent(context)
      RowKind.IMAGE -> ImageContent(context)
      RowKind.RULE -> RuleContent(context)
    }
  }
}

private fun View.dp(value: Float) = value * resources.displayMetrics.density

private fun Context.semibold(): Typeface =
  if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, 600, false) else Typeface.DEFAULT_BOLD

private fun TextView.size(sp: Float, lineSp: Float) {
  setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
  TextViewCompat.setLineHeight(this, TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, lineSp, resources.displayMetrics).roundToInt())
}

private val HEADING_SIZES = floatArrayOf(28f, 22f, 19f, 17f, 17f, 17f)

private class TextContent(private val text: TextView) : BlockContent(text) {
  private var host: Host? = null
  private var rtl = false

  override val firstLine get() = text
  override val isRtl get() = rtl

  init {
    text.includeFontPadding = false
    text.textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    if (text !is BlockEditText) {
      val links = LinkTouch(text::linkAt) { href -> host?.link(href) }
      text.setOnTouchListener(EditTouch({ host }, { null to text.getOffsetForPosition(it.x, it.y) }, links))
    }
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    this.host = host
    val editing = text is BlockEditText
    val content: CharSequence = when (body) {
      is Body.Heading -> {
        val size = HEADING_SIZES[body.level - 1]
        text.size(size, size * 1.3f)
        text.typeface = text.context.semibold()
        text.setTextColor(theme.text)
        runsText(body.runs, theme, editing) { src -> text.inlineImage(host.images, src) }
      }
      is Body.Unsupported -> {
        text.size(theme.fontSize * 0.875f, theme.lineHeight * 0.875f)
        text.typeface = Typeface.create(theme.monoFont, Typeface.NORMAL)
        text.setTextColor(theme.muted)
        body.source
      }
      else -> {
        text.size(theme.fontSize, theme.lineHeight)
        text.typeface = Typeface.DEFAULT
        text.setTextColor(if (quoted) theme.muted else theme.text)
        runsText((body as Body.Paragraph).runs, theme, editing) { src -> text.inlineImage(host.images, src) }
      }
    }
    rtl = TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(content, 0, content.length)
    if (text is BlockEditText) {
      text.tint(theme)
      host.editorBound(text, content)
    } else {
      text.text = content
    }
  }
}

internal fun BlockEditText.tint(theme: DocumentTheme) {
  highlightColor = (theme.accent and 0x00ffffff) or 0x40000000
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) textCursorDrawable?.setTint(theme.accent)
}

private class CodeContent(private val code: TextView) : BlockContent(LinearLayout(code.context)) {
  private val column = view as LinearLayout
  private val label = TextView(code.context)
  private val error = TextView(code.context)
  private val scroller = HorizontalScrollView(code.context)
  private val background = GradientDrawable()
  private var host: Host? = null

  init {
    val pad = view.dp(12f).roundToInt()
    column.orientation = LinearLayout.VERTICAL
    column.background = background
    background.cornerRadius = view.dp(8f)
    label.setPadding(pad, view.dp(8f).roundToInt(), pad, 0)
    label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    code.setPadding(pad, pad, pad, pad)
    code.includeFontPadding = false
    code.setHorizontallyScrolling(true)
    code.textDirection = View.TEXT_DIRECTION_LTR
    error.setPadding(pad, 0, pad, pad)
    error.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
    if (code is BlockEditText) {
      code.inputType = code.inputType or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
      column.addView(label, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      column.addView(code, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    } else {
      scroller.isHorizontalScrollBarEnabled = false
      scroller.overScrollMode = View.OVER_SCROLL_NEVER
      scroller.isFillViewport = true
      scroller.addView(code, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
      code.setOnTouchListener(EditTouch({ host }, { null to code.getOffsetForPosition(it.x, it.y) }))
      column.addView(label, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      column.addView(scroller, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    }
    column.addView(error, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    this.host = host
    background.setColor(theme.codeBackground)
    label.setTextColor(theme.muted)
    error.setTextColor(theme.muted)
    code.setTextColor(theme.codeText)
    code.typeface = Typeface.create(theme.monoFont, Typeface.NORMAL)
    code.size(theme.fontSize * 0.8125f, theme.lineHeight * 0.8125f)
    val (title, source, problem) = when (body) {
      is Body.Diagram -> Triple("Mermaid", highlighted(body.source, emptyList()), null)
      is Body.Chart -> Triple("Chart", highlighted(body.source, emptyList()), null)
      is Body.Code -> Triple(body.language, highlighted(body.text, body.tokens), body.error)
      else -> Triple("", "", null)
    }
    label.text = title
    label.visibility = if (title.isEmpty()) View.GONE else View.VISIBLE
    error.text = problem
    error.visibility = if (problem.isNullOrEmpty()) View.GONE else View.VISIBLE
    if (code is BlockEditText) {
      code.tint(theme)
      host.editorBound(code, source)
    } else {
      code.text = source
      scroller.scrollTo(0, 0)
    }
  }
}

private fun highlighted(text: String, tokens: List<CodeToken>): CharSequence {
  if (tokens.isEmpty()) return text
  val spannable = SpannableString(text)
  for (token in tokens) {
    val start = token.start.coerceIn(0, text.length)
    val end = token.end.coerceIn(start, text.length)
    if (end > start) spannable.setSpan(ForegroundColorSpan(token.color), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }
  return spannable
}

private class ChartContent(context: Context) : BlockContent(ChartView(context)) {
  private var host: Host? = null

  init {
    view.setOnTouchListener(EditTouch({ host }, { null to 0 }))
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    this.host = host
    (view as ChartView).bind(body as Body.Chart, theme)
  }
}

private class DiagramContent(context: Context) : BlockContent(DiagramScroller(context)) {
  private var host: Host? = null

  init {
    (view as DiagramScroller).diagram.setOnTouchListener(EditTouch({ host }, { null to 0 }))
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    this.host = host
    val scroller = view as DiagramScroller
    scroller.diagram.bind((body as Body.Diagram).drawing ?: return, theme)
    scroller.scrollTo(0, 0)
  }
}

/** Lays the cell editor over the cell it edits, letting it grow past the cell until the model's patch resizes the row. */
private class TableFrame(context: Context, val table: TableView) : FrameLayout(context) {
  var editor: BlockEditText? = null
  var cell: Cell? = null

  init {
    addView(table, LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
  }

  private fun editing() = editor?.takeIf { it.visibility == View.VISIBLE }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    table.measure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
    var height = table.measuredHeight
    val editor = editing()
    val rect = cell?.let(table::cellRect)
    if (editor != null && rect != null) {
      editor.minHeight = rect.height().roundToInt()
      editor.measure(
        MeasureSpec.makeMeasureSpec(rect.width().roundToInt().coerceAtLeast(1), MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED),
      )
      height = max(height, (rect.top + editor.measuredHeight).roundToInt())
    }
    setMeasuredDimension(table.measuredWidth, height)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    table.layout(0, 0, table.measuredWidth, table.measuredHeight)
    val editor = editing() ?: return
    val rect = cell?.let(table::cellRect) ?: return
    val x = rect.left.roundToInt()
    val y = rect.top.roundToInt()
    editor.layout(x, y, x + editor.measuredWidth, y + editor.measuredHeight)
  }
}

private class TableContent(context: Context) : BlockContent(HorizontalScrollView(context)) {
  private val table = TableView(context)
  private val frame = TableFrame(context, table)
  private var host: Host? = null

  init {
    val scroller = view as HorizontalScrollView
    scroller.isFillViewport = true
    scroller.overScrollMode = View.OVER_SCROLL_NEVER
    scroller.addView(frame, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    table.onLink = { href -> host?.link(href) }
    val links = table.linkTouch
    table.setOnTouchListener(EditTouch({ host }, { table.cellAt(it.x, it.y)?.let { hit -> hit.cell to hit.offset } }, links))
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    val wasEditing = frame.cell != null
    this.host = host
    table.bind(body as Body.Table, theme)
    val styled = cell?.takeIf { host.editable }?.let { table.cellText(it, theme) }
    table.hiddenCell = if (styled != null) cell else null
    frame.cell = if (styled != null) cell else null
    if (styled == null) {
      frame.editor?.visibility = View.GONE
      if (!wasEditing) view.scrollTo(0, 0)
      return
    }
    val editor = frame.editor ?: BlockEditText(view.context, host.editorListener).also {
      frame.editor = it
      frame.addView(it, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    }
    editor.visibility = View.VISIBLE
    editor.setTextSize(TypedValue.COMPLEX_UNIT_PX, table.textSize)
    editor.setLineSpacing(table.lineSpacing, 1f)
    editor.setTextColor(theme.text)
    editor.gravity = when (table.alignmentOf(cell!!.second)) {
      Layout.Alignment.ALIGN_CENTER -> Gravity.CENTER_HORIZONTAL
      Layout.Alignment.ALIGN_OPPOSITE -> Gravity.END
      else -> Gravity.START
    } or Gravity.TOP
    editor.tint(theme)
    host.editorBound(editor, styled)
  }
}

private class ImageContent(context: Context) : BlockContent(FrameLayout(context)) {
  private val image = ImageView(context)
  private val alt = TextView(context)
  private val placeholder = GradientDrawable()

  init {
    val frame = view as FrameLayout
    image.adjustViewBounds = true
    image.maxHeight = view.dp(480f).roundToInt()
    image.scaleType = ImageView.ScaleType.FIT_START
    alt.textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    placeholder.cornerRadius = view.dp(8f)
    frame.addView(image, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    frame.addView(alt, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    body as Body.Image
    alt.setTextColor(theme.muted)
    alt.setTextSize(TypedValue.COMPLEX_UNIT_SP, theme.fontSize * 0.875f)
    alt.setTypeface(null, Typeface.ITALIC)
    alt.text = body.alt.ifEmpty { body.src }
    placeholder.setColor(theme.surface)
    when (val state = host.images.state(body.src)) {
      is ImageState.Loaded -> {
        image.setImageDrawable(BitmapDrawable(view.resources, state.bitmap))
        image.background = null
        image.minimumHeight = 0
        image.layoutParams.width = WRAP_CONTENT
        image.visibility = View.VISIBLE
        alt.visibility = View.GONE
      }
      ImageState.Loading -> {
        image.setImageDrawable(null)
        image.background = placeholder
        image.minimumHeight = view.dp(160f).roundToInt()
        image.layoutParams.width = MATCH_PARENT
        image.visibility = View.VISIBLE
        alt.visibility = View.GONE
      }
      ImageState.Failed -> {
        image.setImageDrawable(null)
        image.visibility = View.GONE
        alt.visibility = View.VISIBLE
      }
    }
    image.requestLayout()
  }
}

private class RuleView(context: Context) : View(context) {
  val paint = Paint()

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) =
    setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), dp(17f).roundToInt())

  override fun onDraw(canvas: Canvas) {
    val stroke = max(1f, dp(0.5f))
    canvas.drawRect(0f, height / 2f - stroke / 2, width.toFloat(), height / 2f + stroke / 2, paint)
  }
}

private class RuleContent(context: Context) : BlockContent(RuleView(context)) {
  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean, cell: Cell?) {
    (view as RuleView).paint.color = theme.border
    view.invalidate()
  }
}

private fun TextView.inlineImage(images: Images, src: String): BitmapDrawable? {
  val bitmap = (images.state(src) as? ImageState.Loaded)?.bitmap ?: return null
  if (bitmap.height <= 0) return null
  val height = minOf(lineHeight * 1.5f, bitmap.height.toFloat())
  return BitmapDrawable(resources, bitmap).apply {
    setBounds(0, 0, (height * bitmap.width / bitmap.height).roundToInt(), height.roundToInt())
  }
}
