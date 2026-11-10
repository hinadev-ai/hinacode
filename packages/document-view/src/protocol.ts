export const NATIVE_VIEW = "DocumentView"

export const BLOCK_KINDS = [
  "paragraph",
  "heading",
  "code",
  "chart",
  "diagram",
  "table",
  "image",
  "rule",
  "unsupported",
] as const

export const CONTAINER_KINDS = ["bullet", "ordered", "task", "quote", "callout"] as const

export const MARKS = { bold: 1, italic: 2, strike: 4, code: 8 } as const

export const NATIVE_EVENTS = ["ready", "contentSize", "linkPress", "taskToggle", "imageRequest", "error"] as const

export const VIEW_FUNCTIONS = ["applyPatch", "scrollToBlock", "provideImage"] as const

export const DIAGRAM_PATH = { move: 0, line: 1, cubic: 2, close: 3 } as const

export const CAPABILITIES = ["render", "taskToggle", "charts", "images", "highlight", "diagrams"] as const
