import {
  BLOCK_KINDS,
  CAPABILITIES,
  CONTAINER_KINDS,
  MARKS,
  NATIVE_EVENTS,
  NATIVE_VIEW,
  VIEW_FUNCTIONS,
} from "./protocol.ts"

const HEADER =
  "Generated from packages/document-view/src/protocol.ts by `pnpm --dir packages/document-view protocol`. Do not edit."

const upper = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()

const swiftEnum = (name: string, cases: ReadonlyArray<string>) =>
  `enum ${name}: String, CaseIterable {\n${cases.map((value) => `  case ${value}`).join("\n")}\n}\n`

const kotlinEnum = (name: string, cases: ReadonlyArray<string>) =>
  `enum class ${name}(val wire: String) {\n${cases.map((value) => `  ${upper(value)}("${value}")`).join(",\n")};\n\n  companion object {\n    fun of(wire: String): ${name}? = entries.firstOrNull { it.wire == wire }\n  }\n}\n`

export const swiftProtocol = () =>
  [
    `// ${HEADER}\n`,
    `enum DocumentProtocol {\n  static let nativeView = "${NATIVE_VIEW}"\n  static let viewFunctions = [${VIEW_FUNCTIONS.map((name) => `"${name}"`).join(", ")}]\n}\n`,
    swiftEnum("BlockKind", BLOCK_KINDS),
    swiftEnum("ContainerKind", CONTAINER_KINDS),
    swiftEnum("NativeEventType", NATIVE_EVENTS),
    swiftEnum("Capability", CAPABILITIES),
    `struct Marks: OptionSet {\n  let rawValue: Int\n${Object.entries(MARKS)
      .map(([name, bit]) => `  static let ${name} = Marks(rawValue: ${bit})`)
      .join("\n")}\n}\n`,
  ].join("\n")

export const kotlinProtocol = () =>
  [
    `// ${HEADER}\npackage dev.hinacode.documentview\n`,
    `object DocumentProtocol {\n  const val NATIVE_VIEW = "${NATIVE_VIEW}"\n  val VIEW_FUNCTIONS = listOf(${VIEW_FUNCTIONS.map((name) => `"${name}"`).join(", ")})\n}\n`,
    kotlinEnum("BlockKind", BLOCK_KINDS),
    kotlinEnum("ContainerKind", CONTAINER_KINDS),
    kotlinEnum("NativeEventType", NATIVE_EVENTS),
    kotlinEnum("Capability", CAPABILITIES),
    `object Marks {\n${Object.entries(MARKS)
      .map(([name, bit]) => `  const val ${upper(name)} = ${bit}`)
      .join("\n")}\n}\n`,
  ].join("\n")

export const PROTOCOL_FILES = {
  swift: "ios/Protocol.swift",
  kotlin: "android/src/main/java/dev/hinacode/documentview/Protocol.kt",
} as const
