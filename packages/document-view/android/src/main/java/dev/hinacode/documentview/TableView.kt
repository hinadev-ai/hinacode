package dev.hinacode.documentview

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.StyleSpan
import android.view.MotionEvent
import android.view.View
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal typealias Cell = Pair<Int, Int>

internal class CellHit(val cell: Cell, val offset: Int)

internal class TableView(context: Context) : View(context) {
  private val density = resources.displayMetrics.density
  private val cellPadX = 10 * density
  private val cellPadY = 6 * density
  private val minColumn = 48 * density
  private val maxColumn = 280 * density

  private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint().apply { strokeWidth = max(1f, density * 0.5f) }
  private val headerFill = Paint()

  private var table: Body.Table? = null
  private var cells: List<List<SpannableStringBuilder>> = emptyList()
  private var natural = FloatArray(0)
  private var widths = FloatArray(0)
  private var heights = FloatArray(0)
  private var layouts: List<List<StaticLayout>> = emptyList()
  private var measuredFor = -1
  var lineSpacing = 0f
    private set
  val textSize get() = paint.textSize

  var onLink: (String) -> Unit = {}

  /** The cell an editor covers, which the table leaves blank. */
  var hiddenCell: Cell? = null
    set(value) {
      field = value
      invalidate()
    }

  val linkTouch = LinkTouch(::linkAt) { onLink(it) }

  fun cellText(cell: Cell, theme: DocumentTheme): SpannableStringBuilder? {
    val table = table ?: return null
    val runs = table.rows.getOrNull(cell.first)?.getOrNull(cell.second) ?: return null
    val text = runsText(runs, theme, editing = true)
    if (table.header && cell.first == 0) text.setSpan(StyleSpan(Typeface.BOLD), 0, text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
    return text
  }

  fun alignmentOf(column: Int) = alignment(table?.align?.getOrNull(column))

  /** The text area of a cell, inside its padding. */
  fun cellRect(cell: Cell): RectF? {
    val (row, column) = cell
    if (row !in heights.indices || column !in widths.indices) return null
    val left = (0 until column).sumOf { widths[it].toDouble() }.toFloat()
    val top = (0 until row).sumOf { heights[it].toDouble() }.toFloat()
    return RectF(left + cellPadX, top + cellPadY, left + widths[column] - cellPadX, top + heights[row] - cellPadY)
  }

  fun cellAt(x: Float, y: Float): CellHit? {
    var top = 0f
    for (row in layouts.indices) {
      if (y < top + heights[row]) {
        var left = 0f
        for (column in widths.indices) {
          if (x < left + widths[column]) {
            val layout = layouts[row][column]
            val line = layout.getLineForVertical((y - top - cellPadY).toInt())
            return CellHit(row to column, layout.getOffsetForHorizontal(line, x - left - cellPadX))
          }
          left += widths[column]
        }
        return null
      }
      top += heights[row]
    }
    return null
  }

  fun bind(table: Body.Table, theme: DocumentTheme) {
    this.table = table
    paint.textSize = sp(theme.fontSize * 0.875f)
    paint.color = theme.text
    lineSpacing = paint.textSize * 0.35f
    line.color = theme.border
    headerFill.color = theme.surface
    val columns = max(table.align.size, table.rows.maxOfOrNull { it.size } ?: 0)
    cells = table.rows.mapIndexed { rowIndex, row ->
      List(columns) { column ->
        val text = runsText(row.getOrNull(column).orEmpty(), theme)
        if (table.header && rowIndex == 0) {
          text.setSpan(StyleSpan(Typeface.BOLD), 0, text.length, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        }
        text
      }
    }
    natural = FloatArray(columns) { column ->
      val widest = cells.maxOfOrNull { Layout.getDesiredWidth(it[column], paint) } ?: 0f
      (ceil(widest) + 2 * cellPadX).coerceIn(minColumn, maxColumn)
    }
    measuredFor = -1
    requestLayout()
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val total = natural.sum()
    val available = MeasureSpec.getSize(widthMeasureSpec)
    val fill = MeasureSpec.getMode(widthMeasureSpec) == MeasureSpec.EXACTLY && available > total
    val width = if (fill) available else ceil(total).toInt()
    if (width != measuredFor) layoutCells(width, total)
    setMeasuredDimension(width, ceil(heights.sum() + line.strokeWidth).toInt())
  }

  private fun layoutCells(width: Int, total: Float) {
    measuredFor = width
    val stretch = if (total > 0) max(1f, width / total) else 1f
    widths = FloatArray(natural.size) { natural[it] * stretch }
    val align = table?.align.orEmpty()
    layouts = cells.map { row ->
      row.mapIndexed { column, text ->
        val inner = max(1, (widths[column] - 2 * cellPadX).toInt())
        StaticLayout.Builder.obtain(text, 0, text.length, paint, inner)
          .setAlignment(alignment(align.getOrNull(column)))
          .setLineSpacing(lineSpacing, 1f)
          .setIncludePad(false)
          .build()
      }
    }
    heights = FloatArray(layouts.size) { row -> (layouts[row].maxOfOrNull { it.height } ?: 0) + 2 * cellPadY }
  }

  private fun alignment(align: String?) = when (align) {
    "center" -> Layout.Alignment.ALIGN_CENTER
    "right" -> Layout.Alignment.ALIGN_OPPOSITE
    else -> Layout.Alignment.ALIGN_NORMAL
  }

  override fun onDraw(canvas: Canvas) {
    val table = table ?: return
    val half = line.strokeWidth / 2
    if (table.header && heights.isNotEmpty()) canvas.drawRect(0f, 0f, width.toFloat(), heights[0], headerFill)
    var y = 0f
    layouts.forEachIndexed { row, cellsInRow ->
      var x = 0f
      cellsInRow.forEachIndexed { column, layout ->
        if (hiddenCell == row to column) {
          x += widths[column]
          return@forEachIndexed
        }
        canvas.save()
        canvas.translate(x + cellPadX, y + cellPadY)
        layout.draw(canvas)
        canvas.restore()
        x += widths[column]
      }
      canvas.drawLine(0f, y + half, width.toFloat(), y + half, line)
      y += heights[row]
    }
    canvas.drawLine(0f, y + half, width.toFloat(), y + half, line)
    var x = 0f
    for (column in 0..widths.size) {
      val at = min(x + half, width - half)
      canvas.drawLine(at, 0f, at, y + half, line)
      if (column < widths.size) x += widths[column]
    }
  }

  private fun linkAt(event: MotionEvent): LinkSpan? {
    var top = 0f
    for (row in layouts.indices) {
      if (event.y < top + heights[row]) {
        var left = 0f
        for (column in widths.indices) {
          if (event.x < left + widths[column]) {
            return layouts[row][column].linkAt(event.x - left - cellPadX, event.y - top - cellPadY)
          }
          left += widths[column]
        }
        return null
      }
      top += heights[row]
    }
    return null
  }
}
