package dev.hinacode.documentview

import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ClickableSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
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

internal fun runsText(runs: List<Run>, theme: DocumentTheme): SpannableStringBuilder {
  val out = SpannableStringBuilder()
  for (run in runs) {
    val start = out.length
    if (run.image != null) {
      out.append(run.text.replace(OBJECT_REPLACEMENT, run.alt?.ifEmpty { null } ?: run.image.substringAfterLast('/')))
      out.setSpan(ForegroundColorSpan(theme.muted), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
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
