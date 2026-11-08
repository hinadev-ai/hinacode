import { ComposerEditor, type ComposerEditorHandle, iconPaths } from "@hinacode/composer-editor"
import { skillIconShape, slashIconShape } from "@hinacode/icons"
import { useEffect, useImperativeHandle, useRef } from "react"
import { StyleSheet } from "react-native"
import type { ComposerInputProps } from "@/components/composer-input.types"
import { useTheme } from "@/hooks/use-theme"
import { composerDecorations } from "@/lib/composer-text"

const icons = { skill: iconPaths(skillIconShape), slash: iconPaths(slashIconShape) }

/**
 * The composer's field on iOS and Android: a native editor that draws a leading skill and known commands as the
 * desktop's chips, with its icon, and tints mentions and code, while the text stays exactly what the user typed.
 */
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
  const placedStart = selection?.start
  const placedEnd = selection?.end
  useEffect(() => {
    if (placedStart !== undefined) editor.current?.setSelection({ start: placedStart, end: placedEnd ?? placedStart })
  }, [placedStart, placedEnd])
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
        caret: theme.text,
      }}
      placeholder={placeholder}
      fontSize={fontSize}
      lineHeight={typeof lineHeight === "number" ? lineHeight : undefined}
      paddingHorizontal={typeof paddingHorizontal === "number" ? paddingHorizontal : undefined}
      paddingVertical={typeof paddingVertical === "number" ? paddingVertical : undefined}
      style={{ minHeight, maxHeight }}
      onChangeText={({ text }) => onChangeText(text)}
      onChangeSelection={onChangeSelection}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  )
}
