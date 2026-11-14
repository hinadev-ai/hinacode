// Generated from packages/document-view/src/protocol.ts by `pnpm --dir packages/document-view protocol`. Do not edit.
package dev.hinacode.documentview

object DocumentProtocol {
  const val NATIVE_VIEW = "DocumentView"
  val VIEW_FUNCTIONS = listOf("applyPatch", "scrollToBlock", "provideImage", "focus", "blur")
}

enum class BlockKind(val wire: String) {
  PARAGRAPH("paragraph"),
  HEADING("heading"),
  CODE("code"),
  CHART("chart"),
  DIAGRAM("diagram"),
  TABLE("table"),
  IMAGE("image"),
  RULE("rule"),
  UNSUPPORTED("unsupported");

  companion object {
    fun of(wire: String): BlockKind? = entries.firstOrNull { it.wire == wire }
  }
}

enum class ContainerKind(val wire: String) {
  BULLET("bullet"),
  ORDERED("ordered"),
  TASK("task"),
  QUOTE("quote"),
  CALLOUT("callout");

  companion object {
    fun of(wire: String): ContainerKind? = entries.firstOrNull { it.wire == wire }
  }
}

enum class NativeEventType(val wire: String) {
  READY("ready"),
  CONTENT_SIZE("contentSize"),
  LINK_PRESS("linkPress"),
  TASK_TOGGLE("taskToggle"),
  IMAGE_REQUEST("imageRequest"),
  ERROR("error"),
  EDIT("edit"),
  SELECT("select"),
  KEY("key"),
  FOCUS("focus"),
  BLUR("blur"),
  FORMAT("format");

  companion object {
    fun of(wire: String): NativeEventType? = entries.firstOrNull { it.wire == wire }
  }
}

enum class Capability(val wire: String) {
  RENDER("render"),
  TASK_TOGGLE("taskToggle"),
  CHARTS("charts"),
  IMAGES("images"),
  HIGHLIGHT("highlight"),
  DIAGRAMS("diagrams");

  companion object {
    fun of(wire: String): Capability? = entries.firstOrNull { it.wire == wire }
  }
}

object Marks {
  const val BOLD = 1
  const val ITALIC = 2
  const val STRIKE = 4
  const val CODE = 8
}

object DiagramPathOp {
  const val MOVE = 0
  const val LINE = 1
  const val CUBIC = 2
  const val CLOSE = 3
}
