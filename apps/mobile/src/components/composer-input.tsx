import { useImperativeHandle, useRef } from "react"
import { StyleSheet, Text, type TextInputInstance, type TextInstance, type TextStyle, TextInput, View } from "react-native"
import type { ComposerInputProps } from "@/components/composer-input.types"
import type { Palette } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { type ComposerSpan, composerSpans } from "@/lib/composer-text"

// FIXME: A textarea only gives a trailing newline its line once something follows it, so the highlighted copy appends a zero-width space.
const TRAILING_LINE = "​"

const spanStyle = (kind: ComposerSpan["kind"], theme: Palette): TextStyle => {
  switch (kind) {
    case "text":
    case "strong":
      return { color: theme.text }
    case "bullet":
    case "quote":
    case "rule":
      return { color: theme.textMuted }
    case "code":
      return { color: theme.text, backgroundColor: theme.surfaceStrong }
    case "mention":
      return { color: theme.token }
    case "command":
    case "skill":
      return { color: theme.token, backgroundColor: theme.tokenBg }
  }
}

export function ComposerInput({
  ref,
  value,
  commands,
  known,
  selection,
  placeholder,
  style,
  testID,
  accessibilityLabel,
  onChangeText,
  onChangeSelection,
  onFocus,
  onBlur,
}: ComposerInputProps) {
  const theme = useTheme()
  const input = useRef<TextInputInstance>(null)
  const copyRef = useRef<TextInstance>(null)
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus(), blur: () => input.current?.blur() }))
  return (
    <View>
      <Text aria-hidden ref={copyRef} style={[style, StyleSheet.absoluteFill, styles.copy]}>
        {composerSpans(value, commands, known).map((span, index) => (
          <Text key={index} style={spanStyle(span.kind, theme)}>
            {span.text}
          </Text>
        ))}
        {TRAILING_LINE}
      </Text>
      <TextInput
        ref={input}
        testID={testID}
        accessibilityLabel={accessibilityLabel}
        value={value}
        selection={selection}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        multiline
        style={[style, { color: "transparent", caretColor: theme.text } as TextStyle]}
        onChangeText={onChangeText}
        onSelectionChange={(event) => onChangeSelection(event.nativeEvent.selection)}
        onFocus={onFocus}
        onBlur={onBlur}
        onScroll={(event) => {
          // FIXME: react-native-web passes the DOM scroll event, whose target is the textarea.
          const { target } = event.nativeEvent as unknown as { target: HTMLElement }
          const copy = copyRef.current as unknown as HTMLElement | null
          if (copy) copy.scrollTop = target.scrollTop
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  copy: { overflow: "hidden", pointerEvents: "none" },
})
