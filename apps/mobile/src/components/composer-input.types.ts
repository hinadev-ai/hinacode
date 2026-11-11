import type { AgentCommand } from "@shared/agent.ts"
import type { KnownTokens } from "@shared/composerSyntax.ts"
import type { Ref } from "react"
import type { StyleProp, TextStyle } from "react-native"

export interface ComposerInputHandle {
  focus(): void
  blur(): void
}

export interface ComposerSelection {
  readonly start: number
  readonly end: number
}

export interface ComposerInputProps {
  readonly ref?: Ref<ComposerInputHandle>
  readonly value: string
  readonly commands: readonly AgentCommand[]
  readonly known: KnownTokens
  readonly selection?: ComposerSelection
  readonly placeholder: string
  readonly style: StyleProp<TextStyle>
  readonly testID?: string
  readonly accessibilityLabel?: string
  readonly onChangeText: (text: string) => void
  readonly onChangeSelection: (selection: ComposerSelection) => void
  readonly onFocus: () => void
  readonly onBlur: () => void
}
