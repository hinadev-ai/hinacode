package dev.hinacode.documentview

import android.view.MotionEvent
import android.view.View
import android.widget.TextView

internal class LinkTouch(
  private val find: (MotionEvent) -> LinkSpan?,
  private val onLink: (String) -> Unit,
) : View.OnTouchListener {
  private var pressed: LinkSpan? = null

  override fun onTouch(view: View, event: MotionEvent): Boolean = when (event.actionMasked) {
    MotionEvent.ACTION_DOWN -> {
      pressed = find(event)
      pressed != null
    }
    MotionEvent.ACTION_UP -> {
      val link = pressed
      pressed = null
      if (link != null && find(event) === link) onLink(link.href)
      link != null
    }
    MotionEvent.ACTION_CANCEL -> {
      pressed = null
      false
    }
    else -> pressed != null
  }
}

internal fun TextView.linkAt(event: MotionEvent): LinkSpan? =
  layout?.linkAt(event.x - totalPaddingLeft + scrollX, event.y - totalPaddingTop + scrollY)
