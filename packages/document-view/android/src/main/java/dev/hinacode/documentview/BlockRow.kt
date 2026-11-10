package dev.hinacode.documentview

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.text.TextPaint
import android.util.TypedValue
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import androidx.recyclerview.widget.RecyclerView
import kotlin.math.roundToInt

private const val SIDE = 16f
private const val SLOT = 20f
private const val GAP = 12f
private const val LIST_GAP = 6f
private const val CALLOUT_TOP = 10f
private const val CALLOUT_LABEL = 28f
private const val CALLOUT_BOTTOM = 12f
private const val CALLOUT_END = 16f
private const val QUOTE_PAD = 4f

private fun Container.isListItem() = this is Container.Bullet || this is Container.Ordered || this is Container.Task

internal class BlockRow(context: Context, val content: BlockContent) : FrameLayout(context) {
  private val density = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 1.5f * density
  }
  private val check = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 2 * density
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val marker = TextPaint(Paint.ANTI_ALIAS_FLAG)
  private val label = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    typeface = if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, 500, false) else Typeface.DEFAULT_BOLD
  }
  private val rect = RectF()
  private val path = Path()
  private val radii = FloatArray(8)

  private var containers: List<Container> = emptyList()
  private var theme = DocumentTheme()
  private var gapTop = 0f
  private var rtl = false

  init {
    setWillNotDraw(false)
    layoutParams = RecyclerView.LayoutParams(MATCH_PARENT, WRAP_CONTENT)
    addView(content.view, LayoutParams(MATCH_PARENT, WRAP_CONTENT))
  }

  private fun dp(value: Float) = value * density

  fun bind(block: Block, previous: Block?, theme: DocumentTheme, host: Host) {
    this.theme = theme
    containers = block.containers
    content.bind(block.body, theme, host, quoted = containers.any { it is Container.Quote })
    rtl = content.isRtl
    gapTop = gap(previous, block)
    val callouts = containers.filterIsInstance<Container.Callout>()
    val top = gapTop + containers.sumOf { opening(it).toDouble() }.toFloat()
    val bottom = containers.sumOf { closing(it).toDouble() }.toFloat()
    val start = dp(SIDE + SLOT * containers.size)
    val end = dp(SIDE + CALLOUT_END * callouts.size)
    val (left, right) = if (rtl) end to start else start to end
    setPadding(left.roundToInt(), top.roundToInt(), right.roundToInt(), bottom.roundToInt())
    invalidate()
  }

  private fun opening(container: Container) = when {
    container is Container.Callout && container.first -> dp(CALLOUT_TOP + CALLOUT_LABEL)
    container is Container.Quote && container.first -> dp(QUOTE_PAD)
    else -> 0f
  }

  private fun closing(container: Container) = when {
    container is Container.Callout && container.last -> dp(CALLOUT_BOTTOM)
    container is Container.Quote && container.last -> dp(QUOTE_PAD)
    else -> 0f
  }

  private fun gap(previous: Block?, block: Block): Float = when {
    previous == null -> 0f
    block.body is Body.Heading -> dp(if ((block.body as Body.Heading).level <= 2) 24f else 18f)
    block.containers.any { it.isListItem() } && previous.containers.any { it.isListItem() } -> dp(LIST_GAP)
    else -> dp(GAP)
  }

  private fun x(ltr: Float) = if (rtl) width - ltr else ltr

  private fun span(from: Float, to: Float): Pair<Float, Float> = if (rtl) (width - to) to (width - from) else from to to

  override fun onDraw(canvas: Canvas) {
    var openedTop = gapTop
    var closedBottom = height.toFloat()
    var calloutIndex = 0
    var listDepth = 0
    containers.forEachIndexed { index, container ->
      val slot = dp(SIDE + SLOT * index)
      when (container) {
        is Container.Callout -> {
          val top = if (container.first) openedTop else 0f
          val bottom = if (container.last) closedBottom else height.toFloat()
          drawBand(canvas, container, slot, width - dp(SIDE + CALLOUT_END * calloutIndex), top, bottom)
          if (container.first) drawCalloutLabel(canvas, container, slot + dp(SLOT), openedTop + dp(CALLOUT_TOP))
          calloutIndex++
        }
        is Container.Quote -> {
          fill.color = theme.border
          val (left, right) = span(slot + dp(2f), slot + dp(5f))
          val top = if (container.first) openedTop else 0f
          val bottom = if (container.last) closedBottom else height.toFloat()
          canvas.drawRect(left, top, right, bottom, fill)
        }
        is Container.Bullet -> {
          if (container.first) drawBullet(canvas, slot, listDepth)
          listDepth++
        }
        is Container.Ordered -> {
          if (container.first) drawNumber(canvas, slot, container.number)
          listDepth++
        }
        is Container.Task -> {
          if (container.first) drawCheckbox(canvas, slot, container.checked)
          listDepth++
        }
      }
      openedTop += opening(container)
      closedBottom -= closing(container)
    }
  }

  private fun firstLineCenter(): Float {
    val text = content.firstLine ?: return paddingTop + dp(12f)
    val metrics = text.paint.fontMetrics
    return content.view.top + text.baseline + (metrics.ascent + metrics.descent) / 2
  }

  private fun drawBand(canvas: Canvas, callout: Container.Callout, from: Float, to: Float, top: Float, bottom: Float) {
    val (left, right) = span(from, to)
    val radius = dp(10f)
    val topRadius = if (callout.first) radius else 0f
    val bottomRadius = if (callout.last) radius else 0f
    radii.fill(topRadius, 0, 4)
    radii.fill(bottomRadius, 4, 8)
    rect.set(left, top, right, bottom)
    path.reset()
    path.addRoundRect(rect, radii, Path.Direction.CW)
    fill.color = theme.callout(callout.tone).tint
    canvas.drawPath(path, fill)
  }

  private fun drawCalloutLabel(canvas: Canvas, callout: Container.Callout, start: Float, top: Float) {
    label.color = theme.callout(callout.tone).label
    label.textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 12f, resources.displayMetrics)
    label.textAlign = if (rtl) Paint.Align.RIGHT else Paint.Align.LEFT
    val metrics = label.fontMetrics
    val baseline = top + dp(CALLOUT_LABEL - 4f) / 2 - (metrics.ascent + metrics.descent) / 2
    canvas.drawText(theme.calloutLabel(callout.tone), x(start), baseline, label)
  }

  private fun drawBullet(canvas: Canvas, slot: Float, depth: Int) {
    val center = x(slot + dp(9f))
    val y = firstLineCenter()
    val radius = dp(2.75f)
    fill.color = theme.text
    outline.color = theme.text
    when (depth % 3) {
      0 -> canvas.drawCircle(center, y, radius, fill)
      1 -> canvas.drawCircle(center, y, radius - outline.strokeWidth / 2, outline)
      else -> canvas.drawRect(center - radius, y - radius, center + radius, y + radius, fill)
    }
  }

  private fun drawNumber(canvas: Canvas, slot: Float, number: Int) {
    val text = content.firstLine
    marker.textSize = text?.textSize ?: dp(theme.fontSize)
    marker.color = theme.muted
    marker.textAlign = if (rtl) Paint.Align.LEFT else Paint.Align.RIGHT
    val metrics = marker.fontMetrics
    val baseline = firstLineCenter() - (metrics.ascent + metrics.descent) / 2
    canvas.drawText("$number.", x(slot + dp(SLOT - 5f)), baseline, marker)
  }

  private fun drawCheckbox(canvas: Canvas, slot: Float, checked: Boolean) {
    val size = dp(15f)
    val y = firstLineCenter()
    val (left, right) = span(slot, slot + size)
    rect.set(left, y - size / 2, right, y + size / 2)
    val radius = dp(3.5f)
    if (checked) {
      fill.color = theme.accent
      canvas.drawRoundRect(rect, radius, radius, fill)
      check.color = theme.background
      path.reset()
      path.moveTo(rect.left + size * 0.25f, y + size * 0.02f)
      path.lineTo(rect.left + size * 0.43f, y + size * 0.2f)
      path.lineTo(rect.left + size * 0.76f, y - size * 0.18f)
      canvas.drawPath(path, check)
    } else {
      outline.color = theme.muted
      rect.inset(outline.strokeWidth / 2, outline.strokeWidth / 2)
      canvas.drawRoundRect(rect, radius, radius, outline)
    }
  }
}
