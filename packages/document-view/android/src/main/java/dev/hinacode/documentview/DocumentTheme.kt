package dev.hinacode.documentview

import android.graphics.Color
import android.util.TypedValue
import android.view.View
import org.json.JSONObject

internal data class CalloutStyle(val ink: Int, val tint: Int, val label: Int)

internal data class DocumentTheme(
  val text: Int = Color.BLACK,
  val muted: Int = Color.GRAY,
  val link: Int = Color.BLUE,
  val background: Int = Color.WHITE,
  val surface: Int = Color.LTGRAY,
  val border: Int = Color.LTGRAY,
  val codeBackground: Int = Color.LTGRAY,
  val codeText: Int = Color.BLACK,
  val accent: Int = Color.BLUE,
  val callouts: Map<String, CalloutStyle> = emptyMap(),
  val calloutLabels: Map<String, String> = emptyMap(),
  val chartLanes: List<Int> = listOf(Color.BLUE),
  val fontSize: Float = 16f,
  val lineHeight: Float = 24f,
  val monoFont: String = "monospace",
  val diagram: Map<String, Int> = emptyMap(),
) {
  fun diagramPaint(paint: String?): Int? = when {
    paint == null || paint == "none" -> null
    paint.startsWith("@") -> diagram[paint.substring(1)] ?: diagramInk
    else -> parseCssColor(paint) ?: diagramInk
  }

  private val diagramInk get() = diagram["fg"] ?: text

  fun callout(tone: String) = callouts[tone] ?: CalloutStyle(accent, surface, accent)

  fun calloutLabel(tone: String) = calloutLabels[tone] ?: tone.replaceFirstChar { it.uppercase() }

  fun lane(index: Int) = chartLanes[index % chartLanes.size]

  companion object {
    fun parse(json: String): DocumentTheme {
      val source = JSONObject(json)
      val fallback = DocumentTheme()
      fun color(key: String, default: Int) = source.optString(key).let(::parseCssColor) ?: default
      val callouts = source.optJSONObject("callouts")
      val labels = source.optJSONObject("calloutLabels")
      val lanes = source.optJSONArray("chartLanes")
      return DocumentTheme(
        text = color("text", fallback.text),
        muted = color("muted", fallback.muted),
        link = color("link", fallback.link),
        background = color("background", fallback.background),
        surface = color("surface", fallback.surface),
        border = color("border", fallback.border),
        codeBackground = color("codeBackground", fallback.codeBackground),
        codeText = color("codeText", fallback.codeText),
        accent = color("accent", fallback.accent),
        callouts = callouts?.keys()?.asSequence()?.associateWith { tone ->
          val style = callouts.getJSONObject(tone)
          CalloutStyle(
            ink = parseCssColor(style.optString("ink")) ?: fallback.accent,
            tint = parseCssColor(style.optString("tint")) ?: fallback.surface,
            label = parseCssColor(style.optString("label")) ?: fallback.accent,
          )
        } ?: emptyMap(),
        calloutLabels = labels?.keys()?.asSequence()?.associateWith { labels.optString(it) } ?: emptyMap(),
        chartLanes = lanes?.let { array -> (0 until array.length()).mapNotNull { parseCssColor(array.optString(it)) } }
          ?.takeIf { it.isNotEmpty() } ?: fallback.chartLanes,
        fontSize = source.optDouble("fontSize", fallback.fontSize.toDouble()).toFloat(),
        lineHeight = source.optDouble("lineHeight", fallback.lineHeight.toDouble()).toFloat(),
        monoFont = source.optString("monoFont").ifEmpty { fallback.monoFont },
        diagram = source.optJSONObject("diagram")?.let { roles ->
          roles.keys().asSequence().mapNotNull { role -> parseCssColor(roles.optString(role))?.let { role to it } }.toMap()
        } ?: emptyMap(),
      )
    }
  }
}

private val RGBA = Regex("""rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)""")

internal fun parseCssColor(css: String?): Int? {
  val value = css?.trim().orEmpty()
  if (value.isEmpty()) return null
  val rgba = RGBA.matchEntire(value)
  if (rgba != null) {
    val (r, g, b) = rgba.destructured
    val alpha = rgba.groupValues[4].ifEmpty { "1" }.toFloat()
    return Color.argb((alpha * 255).toInt(), r.toFloat().toInt(), g.toFloat().toInt(), b.toFloat().toInt())
  }
  val hex = if (value.length == 4 && value.startsWith("#")) "#" + value.drop(1).map { "$it$it" }.joinToString("") else value
  return runCatching { Color.parseColor(hex) }.getOrNull()
}

internal fun View.sp(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value, resources.displayMetrics)
