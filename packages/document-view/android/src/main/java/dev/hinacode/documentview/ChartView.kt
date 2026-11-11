package dev.hinacode.documentview

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.view.View
import java.text.NumberFormat
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

private const val MAX_SERIES = 6

internal class ChartView(context: Context) : View(context) {
  private val density = resources.displayMetrics.density
  private val pad = 12 * density
  private val gap = 8 * density
  private val plotHeight = 180 * density
  private val labelRow = 18 * density
  private val swatch = 10 * density
  private val legendRow = 18 * density

  private val titlePaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = sp(15f)
    typeface = Typeface.DEFAULT_BOLD
  }
  private val notesPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = sp(12f) }
  private val labelPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = sp(11f) }
  private val gridPaint = Paint().apply { strokeWidth = max(1f, density * 0.5f) }
  private val framePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = density
  }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 2 * density
    strokeJoin = Paint.Join.ROUND
    strokeCap = Paint.Cap.ROUND
  }
  private val frame = RectF()
  private val path = Path()
  private val numbers = NumberFormat.getNumberInstance().apply { maximumFractionDigits = 2 }

  private var chart: Body.Chart? = null
  private var theme = DocumentTheme()
  private var series: List<ChartSeries> = emptyList()
  private var low = 0.0
  private var high = 1.0
  private var axisLabels: List<Pair<Double, String>> = emptyList()
  private var xLabels: List<String> = emptyList()
  private var xLabelWidth = 0f

  private var measuredFor = -1
  private var title: StaticLayout? = null
  private var notes: StaticLayout? = null
  private var legend: List<Triple<Float, Float, String>> = emptyList()
  private var legendHeight = 0f
  private var plotTop = 0f

  fun bind(chart: Body.Chart, theme: DocumentTheme) {
    this.chart = chart
    this.theme = theme
    series = chart.series.take(MAX_SERIES)
    var lowest = Double.POSITIVE_INFINITY
    var highest = Double.NEGATIVE_INFINITY
    for (lane in series) for (value in lane.values) if (!value.isNaN()) {
      lowest = min(lowest, value)
      highest = max(highest, value)
    }
    if (lowest > highest) {
      lowest = 0.0
      highest = 1.0
    }
    low = min(0.0, lowest)
    high = max(0.0, highest)
    if (low == high) high = low + 1
    axisLabels = listOfNotNull(high, low, 0.0.takeIf { low < 0 && high > 0 }).map { it to axisText(it) }
    val maxLabel = 120 * density
    xLabels = chart.x.map { TextUtils.ellipsize(it, labelPaint, maxLabel, TextUtils.TruncateAt.END).toString() }
    xLabelWidth = xLabels.maxOfOrNull { labelPaint.measureText(it) } ?: 0f
    titlePaint.color = theme.text
    notesPaint.color = theme.muted
    labelPaint.color = theme.muted
    gridPaint.color = theme.border
    framePaint.color = theme.border
    measuredFor = -1
    requestLayout()
    invalidate()
  }

  private fun axisText(value: Double) = "${chart?.prefix.orEmpty()}${numbers.format(value)}${chart?.suffix.orEmpty()}"

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    if (width != measuredFor) layoutFor(width)
    var height = pad + plotTop + plotHeight + labelRow + pad
    notes?.let { height += gap + it.height }
    setMeasuredDimension(width, ceil(height).toInt())
  }

  private fun layoutFor(width: Int) {
    measuredFor = width
    val chart = chart ?: return
    val inner = max(1, (width - 2 * pad).toInt())
    title = chart.title.takeIf { it.isNotEmpty() }?.let { text(it, titlePaint, inner) }
    notes = chart.notes.takeIf { it.isNotEmpty() }?.let { text(it, notesPaint, inner) }
    var x = 0f
    var y = 0f
    legend = series.map { lane ->
      val itemWidth = swatch + 6 * density + labelPaint.measureText(lane.label)
      if (x > 0 && x + itemWidth > inner) {
        x = 0f
        y += legendRow
      }
      val item = Triple(x, y, lane.label)
      x += itemWidth + 14 * density
      item
    }
    legendHeight = if (legend.isEmpty()) 0f else y + legendRow
    plotTop = (title?.let { it.height + gap } ?: 0f) + (if (legendHeight > 0) legendHeight + gap else 0f)
  }

  private fun text(value: String, paint: TextPaint, width: Int) =
    StaticLayout.Builder.obtain(value, 0, value.length, paint, width).setAlignment(Layout.Alignment.ALIGN_NORMAL).build()

  override fun onDraw(canvas: Canvas) {
    val chart = chart ?: return
    frame.set(density / 2, density / 2, width - density / 2, height - density / 2)
    canvas.drawRoundRect(frame, 8 * density, 8 * density, framePaint)
    canvas.save()
    canvas.translate(pad, pad)
    title?.let {
      it.draw(canvas)
      canvas.translate(0f, it.height + gap)
    }
    drawLegend(canvas)
    canvas.restore()

    val axisWidth = (axisLabels.maxOfOrNull { labelPaint.measureText(it.second) } ?: 0f) + gap
    val left = pad + axisWidth
    val right = width - pad
    val top = pad + plotTop
    val bottom = top + plotHeight
    fun y(value: Double) = (bottom - (value - low) / (high - low) * plotHeight).toFloat()

    for ((value, label) in axisLabels) {
      val at = y(value)
      canvas.drawLine(left, at, right, at, gridPaint)
      canvas.drawText(label, pad, at + labelPaint.textSize / 3, labelPaint)
    }

    val count = chart.x.size
    if (count > 0) {
      if (chart.line) drawLines(canvas, count, left, right, ::y) else drawBars(canvas, count, left, right, ::y)
      drawXLabels(canvas, count, left, right, bottom, chart.line)
    }

    notes?.let {
      canvas.save()
      canvas.translate(pad, bottom + labelRow + gap)
      it.draw(canvas)
      canvas.restore()
    }
  }

  private fun drawLegend(canvas: Canvas) {
    series.forEachIndexed { index, _ ->
      val (x, y, label) = legend.getOrNull(index) ?: return
      fill.color = theme.lane(index)
      val middle = y + legendRow / 2
      canvas.drawRoundRect(x, middle - swatch / 2, x + swatch, middle + swatch / 2, 2 * density, 2 * density, fill)
      canvas.drawText(label, x + swatch + 6 * density, middle + labelPaint.textSize / 3, labelPaint)
    }
  }

  private fun drawBars(canvas: Canvas, count: Int, left: Float, right: Float, y: (Double) -> Float) {
    val group = (right - left) / count
    val barWidth = group * 0.8f / max(1, series.size)
    val zero = y(0.0)
    series.forEachIndexed { lane, values ->
      fill.color = theme.lane(lane)
      for (index in 0 until min(count, values.values.size)) {
        val value = values.values[index]
        if (value.isNaN()) continue
        val x = left + group * index + group * 0.1f + barWidth * lane
        val at = y(value)
        canvas.drawRect(x, min(at, zero), x + max(barWidth, 1f), max(at, zero), fill)
      }
    }
  }

  private fun drawLines(canvas: Canvas, count: Int, left: Float, right: Float, y: (Double) -> Float) {
    val step = if (count > 1) (right - left) / (count - 1) else 0f
    val dots = count <= 30
    series.forEachIndexed { lane, values ->
      stroke.color = theme.lane(lane)
      fill.color = theme.lane(lane)
      path.reset()
      var drawing = false
      for (index in 0 until min(count, values.values.size)) {
        val value = values.values[index]
        if (value.isNaN()) {
          drawing = false
          continue
        }
        val x = if (count > 1) left + step * index else (left + right) / 2
        val at = y(value)
        if (drawing) path.lineTo(x, at) else path.moveTo(x, at)
        drawing = true
        if (dots) canvas.drawCircle(x, at, 2.5f * density, fill)
      }
      canvas.drawPath(path, stroke)
    }
  }

  private fun drawXLabels(canvas: Canvas, count: Int, left: Float, right: Float, bottom: Float, line: Boolean) {
    val span = right - left
    val every = max(1, ceil((xLabelWidth + gap) * count / span).toInt())
    val baseline = bottom + labelRow - 4 * density
    for (index in 0 until count step every) {
      val label = xLabels[index]
      val center = when {
        line && count > 1 -> left + span / (count - 1) * index
        line -> left + span / 2
        else -> left + span / count * (index + 0.5f)
      }
      val half = labelPaint.measureText(label) / 2
      val x = (center - half).coerceAtMost(right - 2 * half).coerceAtLeast(left - half)
      canvas.drawText(label, x, baseline, labelPaint)
    }
  }
}
