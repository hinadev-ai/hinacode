package dev.hinacode.documentview

import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.TextView
import kotlin.math.abs

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

/**
 * Turns a tap or a long press on a block without an editor into [Host.tap] while the document is editable, and hands
 * touches to [readOnly] otherwise. [target] maps the touch to a cell and an offset in the block's text.
 */
internal class EditTouch(
  private val host: () -> Host?,
  private val target: (MotionEvent) -> Pair<Cell?, Int>?,
  private val readOnly: View.OnTouchListener? = null,
) : View.OnTouchListener {
  private var down: MotionEvent? = null
  private var pressed: View? = null
  private val longPress = Runnable {
    val view = pressed ?: return@Runnable
    val event = down ?: return@Runnable
    pressed = null
    val hit = target(event) ?: return@Runnable
    host()?.tap(view, hit.first, hit.second, long = true)
  }

  override fun onTouch(view: View, event: MotionEvent): Boolean {
    val host = host()
    if (host == null || !host.editable) return readOnly?.onTouch(view, event) ?: false
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        down?.recycle()
        down = MotionEvent.obtain(event)
        pressed = view
        view.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
      }
      MotionEvent.ACTION_MOVE -> {
        val start = down ?: return true
        val slop = ViewConfiguration.get(view.context).scaledTouchSlop
        if (abs(event.x - start.x) > slop || abs(event.y - start.y) > slop) cancel(view)
      }
      MotionEvent.ACTION_UP -> {
        val tapped = pressed === view
        cancel(view)
        if (tapped) target(event)?.let { host.tap(view, it.first, it.second, long = false) }
      }
      MotionEvent.ACTION_CANCEL -> cancel(view)
    }
    return true
  }

  private fun cancel(view: View) {
    pressed = null
    view.removeCallbacks(longPress)
  }
}
