import type { AgentCommand } from "@shared/agent.ts"
import type { KnownTokens } from "@shared/composerSyntax.ts"
import { type Ref, useRef } from "react"
import {
  Platform,
  StyleSheet,
  Text,
  type TextInputInstance,
  type TextInputProps,
  type TextInstance,
  type TextStyle,
  TextInput,
  View,
} from "react-native"
import type { Palette } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { type ComposerSpan, composerSpans } from "@/lib/composer-text"

interface ComposerInputProps extends Omit<TextInputProps, "value" | "children"> {
  readonly ref?: Ref<TextInputInstance>
  readonly value: string
  readonly commands: readonly AgentCommand[]
  readonly known: KnownTokens
}

/** A trailing newline only takes up a line in the textarea once something follows it. */
const TRAILING_LINE = "​"

/** Colors only, never font or spacing: on the web the highlighted copy must wrap exactly like the textarea above it. */
const spanStyle = (kind: ComposerSpan["kind"], theme: Palette): TextStyle => {
  switch (kind) {
    case "text":
      return { color: theme.text }
    case "bullet":
      return { color: theme.textMuted }
    case "code":
      return { color: theme.text, backgroundColor: theme.surfaceStrong }
    case "command":
    case "mention":
      return { color: theme.token }
    case "skill":
      return { color: theme.token, backgroundColor: theme.tokenBg }
  }
}

/**
 * The composer's TextInput with the desktop's highlighting: a skill that starts the message, known commands and
 * mentions, and code. Native inputs render the spans as nested `Text`. react-native-web's textarea cannot, so there
 * its text is transparent over a highlighted copy, as on the desktop.
 */
export function ComposerInput({ ref, value, commands, known, style, onScroll, ...props }: ComposerInputProps) {
  const theme = useTheme()
  const copyRef = useRef<TextInstance>(null)
  const spans = composerSpans(value, commands, known).map((span, index) => (
    <Text key={index} style={spanStyle(span.kind, theme)}>
      {span.text}
    </Text>
  ))

  if (Platform.OS !== "web")
    return (
      <TextInput ref={ref} style={style} {...props}>
        {spans}
      </TextInput>
    )

  return (
    <View>
      <Text aria-hidden ref={copyRef} style={[style, StyleSheet.absoluteFill, styles.copy]}>
        {spans}
        {TRAILING_LINE}
      </Text>
      <TextInput
        ref={ref}
        value={value}
        style={[style, { color: "transparent", caretColor: theme.text } as TextStyle]}
        onScroll={(event) => {
          // react-native-web passes the DOM scroll event, whose target is the textarea.
          const { target } = event.nativeEvent as unknown as { target: HTMLElement }
          const copy = copyRef.current as unknown as HTMLElement | null
          if (copy) copy.scrollTop = target.scrollTop
          onScroll?.(event)
        }}
        {...props}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  copy: { overflow: "hidden", pointerEvents: "none" },
})
