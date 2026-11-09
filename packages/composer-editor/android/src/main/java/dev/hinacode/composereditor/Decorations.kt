package dev.hinacode.composereditor

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.graphics.Typeface
import android.text.style.ReplacementSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import androidx.core.graphics.PathParser

/** Every span this editor adds carries this marker, so the next decoration pass removes exactly its own spans. */
internal interface Decoration

internal class TokenColorSpan(color: Int) : ForegroundColorSpan(color), Decoration

internal class FontStyleSpan(style: Int) : StyleSpan(style), Decoration {
  companion object {
    val bold get() = FontStyleSpan(Typeface.BOLD)
    val italic get() = FontStyleSpan(Typeface.ITALIC)
  }
}

internal class LinkUnderlineSpan : UnderlineSpan(), Decoration

internal class CodeBackgroundSpan(color: Int) : BackgroundColorSpan(color), Decoration

/** Spans a whole chip. The editor paints the pill behind it in `onDraw`, across line breaks too. */
internal class ChipSpan(val background: Int) : Decoration

/**
 * An icon's paths, and the bitmaps they rasterize to. Stroked paths are rasterized again on every frame, and the
 * caret redraws the field twice a second, so each chip draws a cached bitmap instead.
 */
class ChipIcon(paths: List<Pair<String, Boolean>>) {
  private val shapes: List<Pair<Path, Boolean>> = paths.map { (d, fill) -> PathParser.createPathFromPathData(d) to fill }
  private val bitmaps = HashMap<Pair<Int, Int>, Bitmap>()

  internal fun bitmap(sizePx: Int, color: Int): Bitmap =
    bitmaps.getOrPut(sizePx to color) {
      val bitmap = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
      val canvas = Canvas(bitmap)
      val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
        strokeWidth = ICON_STROKE
        this.color = color
      }
      val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        this.color = color
      }
      canvas.scale(sizePx / ICON_GRID, sizePx / ICON_GRID)
      for ((path, filled) in shapes) {
        if (filled) canvas.drawPath(path, fill)
        canvas.drawPath(path, stroke)
      }
      bitmap
    }

  private companion object {
    const val ICON_GRID = 24f
    const val ICON_STROKE = 2.4f
  }
}

/**
 * Draws a chip's icon in place of its first character, the `/` or `$` trigger, as the desktop's chip does.
 * The character stays in the text, so copying and sending see the token the user typed.
 */
internal class ChipIconSpan(private val icon: ChipIcon, private val color: Int) : ReplacementSpan(), Decoration {
  private val blit = Paint(Paint.FILTER_BITMAP_FLAG)

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
    val size = iconSize(paint).toInt()
    val metrics = paint.fontMetrics
    val centerY = y + (metrics.ascent + metrics.descent) / 2
    canvas.drawBitmap(icon.bitmap(size, color), x, centerY - size / 2f, blit)
  }
}
