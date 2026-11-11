import { requireNativeView } from "expo"
import { type Ref, useImperativeHandle, useRef, useState } from "react"
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from "react-native"
import type { ComposerEditorHandle, ComposerEditorProps, PastedImage, Selection } from "./types.ts"

interface NativeChange {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly eventCount: number
}

interface NativeProps {
  readonly ref: Ref<NativeHandle>
  readonly document: string
  readonly icons: string
  readonly theme: string
  readonly placeholder: string
  readonly fontSize: number
  readonly lineHeight: number
  readonly editable: boolean
  readonly paddingHorizontal: number
  readonly paddingVertical: number
  readonly formatActions: string
  readonly style?: StyleProp<ViewStyle>
  readonly testID?: string
  readonly accessibilityLabel?: string
  readonly onEditorChange: (event: NativeSyntheticEvent<NativeChange>) => void
  readonly onEditorSelection: (event: NativeSyntheticEvent<Selection>) => void
  readonly onEditorFocus: () => void
  readonly onEditorBlur: () => void
  readonly onEditorFormat: (event: NativeSyntheticEvent<{ readonly action: string } & Selection>) => void
  readonly onEditorContentSize: (event: NativeSyntheticEvent<{ readonly height: number }>) => void
  readonly onEditorPasteImages: (event: NativeSyntheticEvent<{ readonly images: readonly PastedImage[] }>) => void
}

interface NativeHandle {
  focus(): Promise<void>
  blur(): Promise<void>
}

const NativeEditor = requireNativeView<NativeProps>("ComposerEditor")

export function ComposerEditor({
  ref,
  value,
  decorations,
  icons,
  theme,
  placeholder = "",
  fontSize = 16,
  lineHeight = 0,
  editable = true,
  selection,
  formatActions = [],
  onFormat,
  paddingHorizontal = 0,
  paddingVertical = 0,
  style,
  onChangeText,
  onChangeSelection,
  onFocus,
  onBlur,
  onPasteImages,
  ...rest
}: ComposerEditorProps & { readonly ref?: Ref<ComposerEditorHandle> }) {
  const native = useRef<NativeHandle>(null)
  const [eventCount, setEventCount] = useState(0)
  const [contentHeight, setContentHeight] = useState<number>()
  useImperativeHandle(ref, () => ({
    focus: () => void native.current?.focus(),
    blur: () => void native.current?.blur(),
  }))
  return (
    <NativeEditor
      ref={native}
      {...rest}
      document={JSON.stringify({ value, decorations, eventCount, selection: selection ?? null })}
      icons={JSON.stringify(icons)}
      theme={JSON.stringify(theme)}
      placeholder={placeholder}
      fontSize={fontSize}
      lineHeight={lineHeight}
      editable={editable}
      paddingHorizontal={paddingHorizontal}
      paddingVertical={paddingVertical}
      formatActions={JSON.stringify(formatActions)}
      style={[{ height: contentHeight }, style]}
      onEditorChange={({ nativeEvent }) => {
        setEventCount(nativeEvent.eventCount)
        onChangeText({ text: nativeEvent.text, selection: { start: nativeEvent.start, end: nativeEvent.end } })
      }}
      onEditorSelection={({ nativeEvent }) => onChangeSelection?.(nativeEvent)}
      onEditorFocus={() => onFocus?.()}
      onEditorBlur={() => onBlur?.()}
      onEditorFormat={({ nativeEvent: { action, start, end } }) => onFormat?.(action, { start, end })}
      onEditorContentSize={({ nativeEvent }) => setContentHeight(nativeEvent.height)}
      onEditorPasteImages={({ nativeEvent }) => onPasteImages?.(nativeEvent.images)}
    />
  )
}
