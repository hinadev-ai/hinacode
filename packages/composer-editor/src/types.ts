import type { StyleProp, ViewStyle } from "react-native"

export type Decoration =
  | { readonly kind: "chip"; readonly start: number; readonly end: number; readonly icon: string }
  | { readonly kind: "token" | "code" | "muted"; readonly start: number; readonly end: number }

export interface IconPath {
  readonly d: string
  readonly fill: boolean
}

export interface EditorTheme {
  readonly text: string
  readonly placeholder: string
  readonly token: string
  readonly tokenBackground: string
  readonly codeBackground: string
  readonly muted: string
  readonly caret: string
}

export interface Selection {
  readonly start: number
  readonly end: number
}

export interface ChangeEvent {
  readonly text: string
  readonly selection: Selection
}

export interface ComposerEditorHandle {
  focus(): void
  blur(): void
  setSelection(selection: Selection): void
}

export interface ComposerEditorProps {
  readonly value: string
  readonly decorations: readonly Decoration[]
  readonly icons: Readonly<Record<string, readonly IconPath[]>>
  readonly theme: EditorTheme
  readonly placeholder?: string
  readonly fontSize?: number
  readonly lineHeight?: number
  readonly editable?: boolean
  readonly paddingHorizontal?: number
  readonly paddingVertical?: number
  readonly style?: StyleProp<ViewStyle>
  readonly testID?: string
  readonly accessibilityLabel?: string
  readonly onChangeText: (event: ChangeEvent) => void
  readonly onChangeSelection?: (selection: Selection) => void
  readonly onFocus?: () => void
  readonly onBlur?: () => void
}
