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
import android.text.TextDirectionHeuristics
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
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

  fun link(href: String)
}

internal enum class RowKind { TEXT, CODE, CHART, DIAGRAM, TABLE, IMAGE, RULE }

internal fun rowKind(body: Body) = when (body) {
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

  abstract fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean)

  companion object {
    fun create(context: Context, kind: RowKind): BlockContent = when (kind) {
      RowKind.TEXT -> TextContent(context)
      RowKind.CODE -> CodeContent(context)
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

private class TextContent(context: Context) : BlockContent(TextView(context)) {
  private val text = view as TextView
  private var host: Host? = null
  private var rtl = false

  override val firstLine get() = text
  override val isRtl get() = rtl

  init {
    text.includeFontPadding = false
    text.textDirection = View.TEXT_DIRECTION_FIRST_STRONG
    text.setOnTouchListener(LinkTouch(text::linkAt) { href -> host?.link(href) })
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
    this.host = host
    val content: CharSequence = when (body) {
      is Body.Heading -> {
        val size = HEADING_SIZES[body.level - 1]
        text.size(size, size * 1.3f)
        text.typeface = text.context.semibold()
        text.setTextColor(theme.text)
        runsText(body.runs, theme)
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
        runsText((body as Body.Paragraph).runs, theme)
      }
    }
    rtl = TextDirectionHeuristics.FIRSTSTRONG_LTR.isRtl(content, 0, content.length)
    text.text = content
  }
}

private class CodeContent(context: Context) : BlockContent(LinearLayout(context)) {
  private val column = view as LinearLayout
  private val label = TextView(context)
  private val code = TextView(context)
  private val error = TextView(context)
  private val scroller = HorizontalScrollView(context)
  private val background = GradientDrawable()

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
    scroller.isHorizontalScrollBarEnabled = false
    scroller.overScrollMode = View.OVER_SCROLL_NEVER
    scroller.addView(code, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    column.addView(label, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    column.addView(scroller, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
    column.addView(error, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
    background.setColor(theme.codeBackground)
    label.setTextColor(theme.muted)
    error.setTextColor(theme.muted)
    code.setTextColor(theme.codeText)
    code.typeface = Typeface.create(theme.monoFont, Typeface.NORMAL)
    code.size(theme.fontSize * 0.8125f, theme.lineHeight * 0.8125f)
    val (title, source, problem) = when (body) {
      is Body.Diagram -> Triple("Mermaid", highlighted(body.source, emptyList()), null)
      is Body.Code -> Triple(body.language, highlighted(body.text, body.tokens), body.error)
      else -> Triple("", "", null)
    }
    label.text = title
    label.visibility = if (title.isEmpty()) View.GONE else View.VISIBLE
    code.text = source
    error.text = problem
    error.visibility = if (problem.isNullOrEmpty()) View.GONE else View.VISIBLE
    scroller.scrollTo(0, 0)
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
}

private class ChartContent(context: Context) : BlockContent(ChartView(context)) {
  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
    (view as ChartView).bind(body as Body.Chart, theme)
  }
}

private class DiagramContent(context: Context) : BlockContent(DiagramScroller(context)) {
  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
    val scroller = view as DiagramScroller
    scroller.diagram.bind((body as Body.Diagram).drawing ?: return, theme)
    scroller.scrollTo(0, 0)
  }
}

private class TableContent(context: Context) : BlockContent(HorizontalScrollView(context)) {
  private val table = TableView(context)
  private var host: Host? = null

  init {
    val scroller = view as HorizontalScrollView
    scroller.isFillViewport = true
    scroller.overScrollMode = View.OVER_SCROLL_NEVER
    scroller.addView(table, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    table.onLink = { href -> host?.link(href) }
  }

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
    this.host = host
    table.bind(body as Body.Table, theme)
    view.scrollTo(0, 0)
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

  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
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
  override fun bind(body: Body, theme: DocumentTheme, host: Host, quoted: Boolean) {
    (view as RuleView).paint.color = theme.border
    view.invalidate()
  }
}
