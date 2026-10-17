import { StyleSheet, Text } from "react-native"
import { useTheme } from "@/hooks/use-theme"

/**
 * Renders an agent's Markdown. `root` is the thread's working folder, which relative image paths resolve
 * against; null when it is not known yet.
 */
export function Markdown({ text }: { text: string; root: string | null }) {
  const theme = useTheme()
  return (
    <Text selectable style={[styles.text, { color: theme.text }]}>
      {text}
    </Text>
  )
}

const styles = StyleSheet.create({
  text: { fontSize: 15, lineHeight: 22 },
})
