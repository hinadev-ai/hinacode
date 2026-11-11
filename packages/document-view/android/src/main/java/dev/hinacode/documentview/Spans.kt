package dev.hinacode.documentview

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.ImageSpan
import android.text.style.RelativeSizeSpan
import android.text.style.ReplacementSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.view.View

internal class LinkSpan(val href: String, private val color: Int) : ClickableSpan() {
  override fun onClick(widget: View) = Unit

  override fun updateDrawState(paint: TextPaint) {
    paint.color = color
    paint.isUnderlineText = true
  }
}

private const val OBJECT_REPLACEMENT = "￼"

/** Draws an inline image's label in place of its one-unit object replacement character, so editor offsets match the model. */
private class ImageLabelSpan(private val label: String, private val color: Int) : ReplacementSpan() {
  override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, metrics: Paint.FontMetricsInt?): Int {
    if (metrics != null) paint.getFontMetricsInt(metrics)
    return paint.measureText(label).toInt()
  }

  override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
    val previous = paint.color
    paint.color = color
    canvas.drawText(label, x, y.toFloat(), paint)
    paint.color = previous
  }
}

/** [editing] keeps every run's text as the model has it, which the focused block's editor needs for its offsets. */
internal fun runsText(
  runs: List<Run>,
  theme: DocumentTheme,
  editing: Boolean = false,
  inlineImage: (String) -> Drawable? = { null },
): SpannableStringBuilder {
  val out = SpannableStringBuilder()
  for (run in runs) {
    val start = out.length
    if (run.image != null && editing) {
      out.append(run.text)
      val label = run.alt?.ifEmpty { null } ?: run.image.substringAfterLast('/')
      if (out.length > start) out.setSpan(ImageLabelSpan(label, theme.muted), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    } else if (run.image != null) {
      val drawable = inlineImage(run.image)
      if (drawable != null) {
        out.append(run.text)
        out.setSpan(ImageSpan(drawable, ImageSpan.ALIGN_BASELINE), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      } else {
        out.append(run.text.replace(OBJECT_REPLACEMENT, run.alt?.ifEmpty { null } ?: run.image.substringAfterLast('/')))
        out.setSpan(ForegroundColorSpan(theme.muted), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    } else {
      out.append(run.text)
    }
    val end = out.length
    if (start == end) continue
    fun span(what: Any) = out.setSpan(what, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    val marks = run.marks
    if (marks and Marks.CODE != 0) {
      span(TypefaceSpan(theme.monoFont))
      span(RelativeSizeSpan(0.9f))
      span(BackgroundColorSpan(theme.codeBackground))
    }
    val bold = marks and Marks.BOLD != 0
    val italic = marks and Marks.ITALIC != 0
    when {
      bold && italic -> span(StyleSpan(Typeface.BOLD_ITALIC))
      bold -> span(StyleSpan(Typeface.BOLD))
      italic -> span(StyleSpan(Typeface.ITALIC))
    }
    if (marks and Marks.STRIKE != 0) span(StrikethroughSpan())
    if (run.href != null) span(LinkSpan(run.href, theme.link))
  }
  return out
}

internal fun Layout.linkAt(x: Float, y: Float): LinkSpan? {
  val spanned = text as? Spanned ?: return null
  val line = getLineForVertical(y.toInt())
  if (x < getLineLeft(line) || x > getLineRight(line)) return null
  val offset = getOffsetForHorizontal(line, x)
  return spanned.getSpans(offset, offset, LinkSpan::class.java).firstOrNull()
}
