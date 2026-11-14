package dev.hinacode.documentview

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Base64
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

internal sealed interface ImageState {
  data object Loading : ImageState

  class Loaded(val bitmap: Bitmap) : ImageState

  data object Failed : ImageState
}

private val ARTIFACT_IMAGE = Regex("""^images/[^/]+$""")
private val WEB_IMAGE = Regex("""^https?://""", RegexOption.IGNORE_CASE)

internal class Images(
  private val maxWidth: () -> Int,
  private val request: (String) -> Unit,
  private val changed: (String) -> Unit,
) {
  private val states = HashMap<String, ImageState>()
  private val main = Handler(Looper.getMainLooper())
  private val decoder = Executors.newFixedThreadPool(2)

  fun state(src: String): ImageState = states[src] ?: start(src)

  fun provide(src: String, dataUrl: String) {
    if (dataUrl.isEmpty()) return finish(src, null)
    load(src) { decodeDataUrl(dataUrl) }
  }

  fun release() {
    decoder.shutdownNow()
    states.clear()
  }

  private fun start(src: String): ImageState {
    states[src] = ImageState.Loading
    when {
      ARTIFACT_IMAGE.matches(src) -> request(src)
      WEB_IMAGE.containsMatchIn(src) -> load(src) { download(src) }
      src.startsWith("data:") -> load(src) { decodeDataUrl(src) }
      else -> states[src] = ImageState.Failed
    }
    return states.getValue(src)
  }

  private fun load(src: String, bytes: () -> ByteArray?) {
    val width = maxWidth()
    decoder.execute {
      val bitmap = runCatching { bytes()?.let { decode(it, width) } }.getOrNull()
      main.post { finish(src, bitmap) }
    }
  }

  private fun finish(src: String, bitmap: Bitmap?) {
    if (decoder.isShutdown) return
    states[src] = if (bitmap == null) ImageState.Failed else ImageState.Loaded(bitmap)
    changed(src)
  }
}

private fun decodeDataUrl(dataUrl: String): ByteArray? {
  val comma = dataUrl.indexOf(',')
  if (comma < 0 || !dataUrl.substring(0, comma).endsWith(";base64")) return null
  return Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
}

private fun download(src: String): ByteArray? {
  val connection = URL(src).openConnection() as HttpURLConnection
  connection.connectTimeout = 15_000
  connection.readTimeout = 15_000
  return try {
    if (connection.responseCode !in 200..299) null else connection.inputStream.use { it.readBytes() }
  } finally {
    connection.disconnect()
  }
}

private fun decode(bytes: ByteArray, maxWidth: Int): Bitmap? {
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
  if (bounds.outWidth <= 0) return null
  var sample = 1
  while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
  return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
}
