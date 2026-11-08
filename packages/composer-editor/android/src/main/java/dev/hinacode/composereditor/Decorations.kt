package dev.hinacode.composereditor

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.ReplacementSpan
import androidx.core.graphics.PathParser

/** Every span this editor adds carries this marker, so the next decoration pass removes exactly its own spans. */
internal interface Decoration

internal class TokenColorSpan(color: Int) : ForegroundColorSpan(color), Decoration

internal class CodeBackgroundSpan(color: Int) : BackgroundColorSpan(color), Decoration

/** Spans a whole chip. The editor paints the pill behind it in `onDraw`, across line breaks too. */
internal class ChipSpan(val background: Int) : Decoration

class ChipIcon(paths: List<Pair<String, Boolean>>) {
  internal val shapes: List<Pair<Path, Boolean>> = paths.map { (d, fill) -> PathParser.createPathFromPathData(d) to fill }
}

/**
 * Draws a chip's icon in place of its first character, the `/` or `$` trigger, as the desktop's chip does.
 * The character stays in the text, so copying and sending see the token the user typed.
 */
internal class ChipIconSpan(private val icon: ChipIcon, private val color: Int) : ReplacementSpan(), Decoration {
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
    strokeWidth = ICON_STROKE
  }
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

  private fun iconSize(paint: Paint) = paint.textSize * 0.9f

  override fun getSize(paint: Paint, text: CharSequence, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
    if (fm != null) paint.getFontMetricsInt(fm)
    return (iconSize(paint) + paint.textSize * 0.2f).toInt()
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    val size = iconSize(paint)
    val metrics = paint.fontMetrics
    val centerY = y + (metrics.ascent + metrics.descent) / 2
    stroke.color = color
    fill.color = color
    canvas.save()
    canvas.translate(x, centerY - size / 2)
    canvas.scale(size / ICON_GRID, size / ICON_GRID)
    for ((path, filled) in icon.shapes) {
      if (filled) canvas.drawPath(path, fill)
      canvas.drawPath(path, stroke)
    }
    canvas.restore()
  }

  private companion object {
    const val ICON_GRID = 24f
    const val ICON_STROKE = 2.4f
  }
}
