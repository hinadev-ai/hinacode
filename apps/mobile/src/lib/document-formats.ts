import type { DocumentActionType } from "@hinacode/document-view"
import { copy } from "@/lib/copy"

type MarkToggle = "toggleBold" | "toggleItalic" | "toggleStrike" | "toggleCode"

const markToggles = new Set<DocumentActionType>(["toggleBold", "toggleItalic", "toggleStrike", "toggleCode"])

export const isMarkToggle = (type: DocumentActionType): type is MarkToggle => markToggles.has(type)

export const selectionFormats = [
  { id: "toggleBold", label: copy("mobile_document_bold") },
  { id: "toggleItalic", label: copy("mobile_document_italic") },
  { id: "toggleStrike", label: copy("mobile_document_strike") },
  { id: "toggleCode", label: copy("mobile_document_code") },
  { id: "setLink", label: copy("mobile_document_link") },
] as const satisfies readonly { id: DocumentActionType; label: string }[]
