package dev.hinacode.documentview

import android.graphics.Path
import org.json.JSONArray
import org.json.JSONObject

internal class Run(val text: String, val marks: Int, val href: String?, val image: String?, val alt: String?)

internal sealed interface Container {
  data class Bullet(val first: Boolean) : Container

  data class Ordered(val number: Int, val first: Boolean) : Container

  data class Task(val checked: Boolean, val first: Boolean) : Container

  data class Quote(val first: Boolean, val last: Boolean) : Container

  data class Callout(val tone: String, val first: Boolean, val last: Boolean) : Container
}

internal class CodeToken(val start: Int, val end: Int, val color: Int)

internal class ChartSeries(val label: String, val values: DoubleArray)

internal sealed interface Body {
  class Paragraph(val runs: List<Run>) : Body

  class Heading(val level: Int, val runs: List<Run>) : Body

  class Code(val language: String, val text: String, val tokens: List<CodeToken>, val error: String?) : Body

  class Chart(
    val source: String,
    val line: Boolean,
    val title: String,
    val notes: String,
    val x: List<String>,
    val series: List<ChartSeries>,
    val prefix: String,
    val suffix: String,
  ) : Body

  class Diagram(val source: String, val drawing: DiagramDrawing?) : Body

  class Table(val align: List<String?>, val header: Boolean, val rows: List<List<List<Run>>>) : Body

  class Image(val src: String, val alt: String) : Body

  data object Rule : Body

  class Unsupported(val source: String) : Body
}

internal sealed interface DiagramShape {
  class Stroke(
    val path: Path,
    val fill: String?,
    val stroke: String?,
    val width: Float,
    val dash: FloatArray?,
    val opacity: Float,
  ) : DiagramShape

  class Label(
    val text: String,
    val x: Float,
    val y: Float,
    val anchor: String,
    val size: Float,
    val bold: Boolean,
    val fill: String?,
  ) : DiagramShape
}

internal class DiagramDrawing(val width: Float, val height: Float, val shapes: List<DiagramShape>)

internal class Block(val id: String, val containers: List<Container>, val body: Body)

internal fun JSONObject.toBlock() = Block(
  id = optString("id"),
  containers = optJSONArray("containers").objects().mapNotNull { it.toContainer() },
  body = toBody(),
)

private fun JSONArray?.objects(): List<JSONObject> =
  if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONObject.stringOrNull(key: String) = if (has(key) && !isNull(key)) optString(key) else null

private fun JSONObject.toContainer(): Container? = when (ContainerKind.of(optString("kind"))) {
  ContainerKind.BULLET -> Container.Bullet(optBoolean("first"))
  ContainerKind.ORDERED -> Container.Ordered(optInt("number", 1), optBoolean("first"))
  ContainerKind.TASK -> Container.Task(optBoolean("checked"), optBoolean("first"))
  ContainerKind.QUOTE -> Container.Quote(optBoolean("first"), optBoolean("last"))
  ContainerKind.CALLOUT -> Container.Callout(optString("tone"), optBoolean("first"), optBoolean("last"))
  null -> null
}

private fun JSONArray?.runs(): List<Run> = objects().map {
  Run(it.optString("text"), it.optInt("marks"), it.stringOrNull("href"), it.stringOrNull("image"), it.stringOrNull("alt"))
}

private fun JSONObject.toBody(): Body = when (BlockKind.of(optString("kind"))) {
  BlockKind.PARAGRAPH -> Body.Paragraph(optJSONArray("runs").runs())
  BlockKind.HEADING -> Body.Heading(optInt("level", 1).coerceIn(1, 6), optJSONArray("runs").runs())
  BlockKind.CODE -> Body.Code(
    language = optString("language"),
    text = optString("text"),
    tokens = optJSONArray("tokens").tokens(),
    error = stringOrNull("error"),
  )
  BlockKind.CHART -> toChart()
  BlockKind.DIAGRAM -> Body.Diagram(optString("source"), optJSONObject("drawing")?.toDrawing())
  BlockKind.TABLE -> toTable()
  BlockKind.IMAGE -> Body.Image(optString("src"), optString("alt"))
  BlockKind.RULE -> Body.Rule
  BlockKind.UNSUPPORTED -> Body.Unsupported(optString("source"))
  null -> Body.Unsupported(fallbackText())
}

private fun JSONObject.fallbackText(): String =
  stringOrNull("source") ?: stringOrNull("text") ?: optJSONArray("runs").runs().joinToString("") { it.text }

private fun JSONArray?.tokens(): List<CodeToken> {
  if (this == null) return emptyList()
  return (0 until length()).mapNotNull { index ->
    val token = optJSONArray(index) ?: return@mapNotNull null
    val color = parseCssColor(token.optString(2)) ?: return@mapNotNull null
    CodeToken(token.optInt(0), token.optInt(1), color)
  }
}

private fun JSONArray?.strings(): List<String> =
  if (this == null) emptyList() else (0 until length()).map { optString(it) }

private fun JSONObject.toChart() = Body.Chart(
  source = optString("source"),
  line = optString("type") == "line",
  title = optString("title"),
  notes = optString("notes"),
  x = optJSONArray("x").strings(),
  series = optJSONArray("series").objects().map { series ->
    val values = series.optJSONArray("values")
    ChartSeries(
      label = series.optString("label"),
      values = DoubleArray(values?.length() ?: 0) { values!!.optDouble(it) },
    )
  },
  prefix = optString("prefix"),
  suffix = optString("suffix"),
)

private fun JSONObject.toTable(): Body.Table {
  val align = optJSONArray("align")
  val rows = optJSONArray("rows")
  return Body.Table(
    align = (0 until (align?.length() ?: 0)).map { align!!.stringOrNull(it) },
    header = optBoolean("header"),
    rows = (0 until (rows?.length() ?: 0)).map { row ->
      val cells = rows!!.optJSONArray(row)
      (0 until (cells?.length() ?: 0)).map { cells!!.optJSONArray(it).runs() }
    },
  )
}

private fun JSONArray.stringOrNull(index: Int) = if (isNull(index)) null else optString(index)

private fun JSONObject.toDrawing(): DiagramDrawing? {
  val width = optDouble("width").toFloat()
  val height = optDouble("height").toFloat()
  if (!(width > 0f) || !(height > 0f)) return null
  val shapes = optJSONArray("shapes").objects().mapNotNull { shape ->
    when (shape.optString("kind")) {
      "path" -> DiagramShape.Stroke(
        path = shape.optJSONArray("data").toPath(),
        fill = shape.stringOrNull("fill"),
        stroke = shape.stringOrNull("stroke"),
        width = shape.optDouble("width", 1.0).toFloat(),
        dash = shape.optJSONArray("dash")?.let { dash -> FloatArray(dash.length()) { dash.optDouble(it).toFloat() } },
        opacity = shape.optDouble("opacity", 1.0).toFloat(),
      )
      "text" -> DiagramShape.Label(
        text = shape.optString("text"),
        x = shape.optDouble("x").toFloat(),
        y = shape.optDouble("y").toFloat(),
        anchor = shape.optString("anchor"),
        size = shape.optDouble("size", 14.0).toFloat(),
        bold = shape.optInt("weight", 400) >= 600,
        fill = shape.stringOrNull("fill"),
      )
      else -> null
    }
  }
  return DiagramDrawing(width, height, shapes)
}

private fun JSONArray?.toPath(): Path {
  val path = Path()
  if (this == null) return path
  fun at(index: Int) = optDouble(index).toFloat()
  var index = 0
  while (index < length()) {
    when (optInt(index)) {
      DiagramPathOp.MOVE -> {
        path.moveTo(at(index + 1), at(index + 2))
        index += 3
      }
      DiagramPathOp.LINE -> {
        path.lineTo(at(index + 1), at(index + 2))
        index += 3
      }
      DiagramPathOp.CUBIC -> {
        path.cubicTo(at(index + 1), at(index + 2), at(index + 3), at(index + 4), at(index + 5), at(index + 6))
        index += 7
      }
      DiagramPathOp.CLOSE -> {
        path.close()
        index += 1
      }
      else -> break
    }
  }
  return path
}
