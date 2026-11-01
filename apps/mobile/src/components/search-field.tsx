import { useRef, useState } from "react"
import { Platform, Pressable, StyleSheet, TextInput, type TextInputInstance, View } from "react-native"
import Animated from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { cssEase, duration } from "@/constants/motion"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"

/** A rounded search field whose clear button fades in once there is text. */
export function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder,
  clearLabel,
  testID,
}: {
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  placeholder: string
  clearLabel: string
  testID?: string
}) {
  const theme = useTheme()
  const input = useRef<TextInputInstance>(null)
  const [focused, setFocused] = useState(false)
  const filled = value !== ""
  const clear = () => {
    onChange("")
    input.current?.focus()
  }
  return (
    <View
      style={[styles.field, { backgroundColor: theme.surface, borderColor: focused ? theme.primary : "transparent" }]}
    >
      <Icon name="RiSearchLine" size={18} color={theme.textMuted} />
      <TextInput
        ref={input}
        testID={testID}
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChange}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={theme.textMuted}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        style={[styles.input, { color: theme.text }]}
      />
      <Animated.View
        style={{
          pointerEvents: filled ? "auto" : "none",
          opacity: filled ? 1 : 0,
          transitionProperty: "opacity",
          transitionDuration: duration.fast,
          transitionTimingFunction: cssEase.out,
        }}
      >
        <Pressable
          testID={testID === undefined ? undefined : `${testID}-clear`}
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          aria-hidden={!filled}
          tabIndex={filled ? 0 : -1}
          hitSlop={10}
          onPress={clear}
          style={styles.clear}
        >
          <Icon name="RiCloseCircleFill" size={18} color={theme.textMuted} />
        </Pressable>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  field: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontSize: 16,
    paddingVertical: 10,
    // The field's border shows focus, so the browser's own ring would draw a square inside the rounded field.
    ...Platform.select({ web: { outlineStyle: "none" } as object }),
  },
  clear: { padding: 4 },
})
