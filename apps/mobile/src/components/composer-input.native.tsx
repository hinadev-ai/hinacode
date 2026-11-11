import { ComposerEditor, type ComposerEditorHandle, iconPaths } from "@hinacode/composer-editor"
import { skillIconShape, slashIconShape } from "@hinacode/icons"
import { useImperativeHandle, useRef, useState } from "react"
import { StyleSheet } from "react-native"
import type { ComposerInputProps } from "@/components/composer-input.types"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { composerDecorations, formatSelection, type TextFormat } from "@/lib/composer-text"

const icons = { skill: iconPaths(skillIconShape), slash: iconPaths(slashIconShape) }

const formats: readonly TextFormat[] = ["strong", "emphasis", "link"]
const formatLabels = {
  strong: "mobile_composer_format_bold",
  emphasis: "mobile_composer_format_italic",
  link: "mobile_composer_format_link",
} as const

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
  const editor = useRef<ComposerEditorHandle>(null)
  const { fontSize, lineHeight, paddingHorizontal, paddingVertical, minHeight, maxHeight } = StyleSheet.flatten(style) ?? {}
  useImperativeHandle(ref, () => ({ focus: () => editor.current?.focus(), blur: () => editor.current?.blur() }))
  const [formatted, setFormatted] = useState<{ readonly start: number; readonly end: number }>()
  return (
    <ComposerEditor
      ref={editor}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      value={value}
      decorations={composerDecorations(value, commands, known)}
      icons={icons}
      theme={{
        text: theme.text,
        placeholder: theme.textMuted,
        token: theme.token,
        tokenBackground: theme.tokenBg,
        codeBackground: theme.surfaceStrong,
        muted: theme.textMuted,
        link: theme.primary,
        caret: theme.text,
      }}
      placeholder={placeholder}
      fontSize={fontSize}
      lineHeight={typeof lineHeight === "number" ? lineHeight : undefined}
      paddingHorizontal={typeof paddingHorizontal === "number" ? paddingHorizontal : undefined}
      paddingVertical={typeof paddingVertical === "number" ? paddingVertical : undefined}
      style={{ minHeight, maxHeight }}
      selection={formatted ?? selection}
      formatActions={formats.map((format) => ({ id: format, label: copy(formatLabels[format]) }))}
      onFormat={(action, range) => {
        const next = formatSelection(value, range, action as TextFormat)
        setFormatted(next.selection)
        onChangeText(next.text)
      }}
      onChangeText={({ text }) => {
        setFormatted(undefined)
        onChangeText(text)
      }}
      onChangeSelection={onChangeSelection}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  )
}
