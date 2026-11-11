// Generated from packages/document-view/src/protocol.ts by `pnpm --dir packages/document-view protocol`. Do not edit.

enum DocumentProtocol {
  static let nativeView = "DocumentView"
  static let viewFunctions = ["applyPatch", "scrollToBlock", "provideImage", "focus", "blur"]
}

enum BlockKind: String, CaseIterable {
  case paragraph
  case heading
  case code
  case chart
  case diagram
  case table
  case image
  case rule
  case unsupported
}

enum ContainerKind: String, CaseIterable {
  case bullet
  case ordered
  case task
  case quote
  case callout
}

enum NativeEventType: String, CaseIterable {
  case ready
  case contentSize
  case linkPress
  case taskToggle
  case imageRequest
  case error
  case edit
  case select
  case key
  case focus
  case blur
  case format
}

enum Capability: String, CaseIterable {
  case render
  case taskToggle
  case charts
  case images
  case highlight
  case diagrams
}

struct Marks: OptionSet {
  let rawValue: Int
  static let bold = Marks(rawValue: 1)
  static let italic = Marks(rawValue: 2)
  static let strike = Marks(rawValue: 4)
  static let code = Marks(rawValue: 8)
}

enum DiagramPathOp: Int {
  case move = 0
  case line = 1
  case cubic = 2
  case close = 3
}
