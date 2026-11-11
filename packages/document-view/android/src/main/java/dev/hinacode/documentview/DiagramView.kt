package dev.hinacode.documentview

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Typeface
import android.view.View
import android.widget.HorizontalScrollView
import kotlin.math.ceil
import kotlin.math.roundToInt

private const val MAX_SCALE = 1.5f
private const val MIN_SCALE = 0.6f

internal class DiagramScroller(context: Context) : HorizontalScrollView(context) {
  val diagram = DiagramView(context)

  init {
    isHorizontalScrollBarEnabled = false
    overScrollMode = OVER_SCROLL_NEVER
    addView(diagram, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    diagram.viewport = MeasureSpec.getSize(widthMeasureSpec)
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
  }
}

internal class DiagramView(context: Context) : View(context) {
  private val density = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeJoin = Paint.Join.ROUND
    strokeCap = Paint.Cap.ROUND
  }
  private val text = Paint(Paint.ANTI_ALIAS_FLAG)

  private var drawing: DiagramDrawing? = null
  private var theme = DocumentTheme()
  private var scale = 1f
  var viewport = 0

  fun bind(drawing: DiagramDrawing, theme: DocumentTheme) {
    this.drawing = drawing
    this.theme = theme
    requestLayout()
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val drawing = drawing ?: return setMeasuredDimension(0, 0)
    val natural = drawing.width * density
    val fit = if (viewport > 0) (viewport / natural).coerceIn(MIN_SCALE, MAX_SCALE) else 1f
    scale = fit * density
    setMeasuredDimension(ceil(drawing.width * scale).toInt(), ceil(drawing.height * scale).toInt())
  }

  override fun onDraw(canvas: Canvas) {
    val drawing = drawing ?: return
    canvas.save()
    canvas.scale(scale, scale)
    for (shape in drawing.shapes) when (shape) {
      is DiagramShape.Stroke -> drawPath(canvas, shape)
      is DiagramShape.Label -> drawLabel(canvas, shape)
    }
    canvas.restore()
  }

  private fun drawPath(canvas: Canvas, shape: DiagramShape.Stroke) {
    val alpha = (shape.opacity.coerceIn(0f, 1f) * 255).roundToInt()
    theme.diagramPaint(shape.fill)?.let {
      fill.color = it
      fill.alpha = fill.alpha * alpha / 255
      canvas.drawPath(shape.path, fill)
    }
    theme.diagramPaint(shape.stroke)?.let {
      stroke.color = it
      stroke.alpha = stroke.alpha * alpha / 255
      stroke.strokeWidth = shape.width
      stroke.pathEffect = shape.dash?.takeIf { dash -> dash.isNotEmpty() && dash.any { part -> part > 0 } }?.let { dash ->
        DashPathEffect(if (dash.size % 2 == 0) dash else dash + dash, 0f)
      }
      canvas.drawPath(shape.path, stroke)
    }
  }

  private fun drawLabel(canvas: Canvas, label: DiagramShape.Label) {
    text.color = theme.diagramPaint(label.fill) ?: theme.text
    text.textSize = label.size
    text.typeface = if (label.bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    text.textAlign = when (label.anchor) {
      "middle" -> Paint.Align.CENTER
      "end" -> Paint.Align.RIGHT
      else -> Paint.Align.LEFT
    }
    canvas.drawText(label.text, label.x, label.y, text)
  }
}
