import type { StyleProp, ViewStyle } from "react-native"
import type { CAPABILITIES } from "./protocol.ts"
import type { DocumentAction, DocumentActionType, SelectionState } from "./actions.ts"
import type { CodeToken, DocumentTheme } from "./blocks.ts"

export type Capability = (typeof CAPABILITIES)[number]

export type Result<Reason extends string = string> =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: Reason }

export type DocumentError = {
  readonly kind: "unsupported" | "image" | "lossy"
  readonly message: string
}

export type DocumentEditorHandle = {
  readonly getMarkdown: () => string
  readonly scrollTo: (position: number) => Promise<Result<"not-loaded">>
  readonly run: (action: DocumentAction) => Promise<Result<"not-applicable" | "not-loaded">>
  readonly focus: () => Promise<Result<"not-loaded">>
  readonly blur: () => Promise<Result<"not-loaded">>
}

export type DocumentEditorProps = {
  readonly document: { readonly revision: number; readonly markdown: string }
  readonly theme: DocumentTheme
  readonly resolveImage: (path: string) => Promise<string>
  readonly highlightCode?: (code: string, language: string) => ReadonlyArray<CodeToken>
  readonly editable?: boolean
  readonly contentInset?: { readonly top: number; readonly bottom: number }
  readonly onLinkPress?: (href: string) => void
  readonly onContentSizeChange?: (size: { readonly height: number }) => void
  readonly onError?: (error: DocumentError) => void
  readonly onReady?: (ready: { readonly capabilities: ReadonlyArray<Capability> }) => void
  readonly onLoaded?: (loaded: { readonly blocks: number }) => void
  readonly onChange?: () => void
  readonly onSelectionChange?: (selection: SelectionState) => void
  readonly onFocus?: () => void
  readonly onBlur?: () => void
  readonly formatActions?: ReadonlyArray<{ readonly id: DocumentActionType; readonly label: string }>
  readonly onFormat?: (action: DocumentActionType) => void
  readonly style?: StyleProp<ViewStyle>
  readonly testID?: string
}
