package dev.hinacode.documentview

import android.annotation.SuppressLint
import android.content.Context
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import kotlin.math.roundToInt

private val CAPABILITIES = listOf(Capability.RENDER, Capability.CHARTS, Capability.IMAGES, Capability.HIGHLIGHT, Capability.DIAGRAMS)

@SuppressLint("ViewConstructor")
class DocumentView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onDocumentEvent by EventDispatcher()
  private val density = resources.displayMetrics.density

  var editable = false
  private var themeJson = ""
  private var insetTop = 0f
  private var insetBottom = 0f
  private var announced = false
  private var reportedHeight = -1

  private val images: Images = Images(
    maxWidth = { width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels },
    request = { src -> send(NativeEventType.IMAGE_REQUEST, "src" to src) },
    changed = { src -> adapter.imageChanged(src) },
  )

  private val adapter: BlockAdapter = BlockAdapter(object : Host {
    override val images get() = this@DocumentView.images

    override fun link(href: String) = send(NativeEventType.LINK_PRESS, "href" to href)
  })

  private val layoutManager = LinearLayoutManager(context)

  private val list = RecyclerView(context).apply {
    layoutManager = this@DocumentView.layoutManager
    adapter = this@DocumentView.adapter
    itemAnimator = null
    clipToPadding = false
    recycledViewPool.setMaxRecycledViews(RowKind.TEXT.ordinal, 24)
    addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reportContentSize() }
    addOnScrollListener(object : RecyclerView.OnScrollListener() {
      override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
        if (newState == RecyclerView.SCROLL_STATE_IDLE) reportContentSize()
      }
    })
  }

  init {
    addView(list, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (announced) return
    announced = true
    post { send(NativeEventType.READY, "capabilities" to CAPABILITIES.map { it.wire }) }
  }

  @SuppressLint("NotifyDataSetChanged")
  fun setTheme(json: String) {
    if (json == themeJson) return
    themeJson = json
    adapter.theme = runCatching { DocumentTheme.parse(json) }.getOrElse {
      send(NativeEventType.ERROR, "message" to "theme: ${it.message}")
      DocumentTheme()
    }
    if (adapter.itemCount > 0) adapter.notifyDataSetChanged()
  }

  fun setContentInset(top: Float = insetTop, bottom: Float = insetBottom) {
    insetTop = top
    insetBottom = bottom
    list.setPadding(0, (top * density).roundToInt(), 0, (bottom * density).roundToInt())
  }

  fun applyPatch(json: String) {
    try {
      val patch = JSONObject(json)
      val start = patch.optInt("start").coerceIn(0, adapter.blocks.size)
      val deleteCount = patch.optInt("deleteCount").coerceIn(0, adapter.blocks.size - start)
      val insert = patch.optJSONArray("insert")
      val blocks = (0 until (insert?.length() ?: 0)).mapNotNull { insert!!.optJSONObject(it)?.toBlock() }
      adapter.splice(start, deleteCount, blocks)
      post { reportContentSize() }
    } catch (error: Exception) {
      send(NativeEventType.ERROR, "message" to "patch: ${error.message}")
    }
  }

  fun scrollToBlock(index: Int) {
    if (index in 0 until adapter.itemCount) layoutManager.scrollToPositionWithOffset(index, 0)
  }

  fun provideImage(src: String, dataUrl: String) = images.provide(src, dataUrl)

  fun release() = images.release()

  private fun reportContentSize() {
    val height = (list.computeVerticalScrollRange() / density + insetTop + insetBottom).roundToInt()
    if (height == reportedHeight) return
    reportedHeight = height
    send(NativeEventType.CONTENT_SIZE, "height" to height)
  }

  private fun send(type: NativeEventType, vararg fields: Pair<String, Any>) =
    onDocumentEvent(mapOf("type" to type.wire, *fields))
}
