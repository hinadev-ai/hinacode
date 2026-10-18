import { setStringAsync } from "expo-clipboard"
import { useEffect, useState } from "react"
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type ViewProps } from "react-native"
import { Icon } from "@/components/icon"
import { IconSwap } from "@/components/motion"
import { HIT, mono, radius, SyntaxColors } from "@/constants/theme"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { useHighlight } from "@/lib/highlight"

const COPIED_MS = 1500

/**
 * A fenced code block: its language, a copy button, and the highlighted code scrolling sideways. Tabs draw as two
 * spaces, since a phone has no width to spare; Copy still takes the original text.
 */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const theme = useTheme()
  const colors = SyntaxColors[useScheme()]
  const { spans, engine } = useHighlight(code)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  // react-native-web turns `dataSet` into data attributes; the native View props do not declare it.
  const engineAttribute = (Platform.OS === "web" ? { dataSet: { lexer: engine } } : {}) as ViewProps

  return (
    <View
      testID="code-block"
      {...engineAttribute}
      style={[styles.block, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      <View style={styles.header}>
        <Text numberOfLines={1} style={[styles.language, { color: theme.textMuted }]}>
          {language}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy(copied ? "mobile_code_copied" : "mobile_code_copy")}
          hitSlop={(HIT - 28) / 2}
          onPress={() => void setStringAsync(code).then(() => setCopied(true), () => {})}
          style={styles.copy}
        >
          <IconSwap
            showSecond={copied}
            first={<Icon name="RiFileCopyLine" size={16} color={theme.textMuted} />}
            second={<Icon name="RiCheckLine" size={16} color={theme.running} />}
          />
        </Pressable>
      </View>
      <ScrollView horizontal contentContainerStyle={styles.scroll}>
        <Text selectable style={[styles.code, { color: colors.plain }]}>
          {spans.map((span) => (
            <Text
              key={span.start}
              style={{ color: colors[span.type], fontStyle: span.type === "comment" ? "italic" : "normal" }}
            >
              {code.slice(span.start, span.end).replace(/\t/g, "  ")}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  block: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: 12, paddingRight: 4, paddingVertical: 4, gap: 8 },
  language: { flex: 1, fontSize: 12 },
  copy: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  scroll: { paddingHorizontal: 12, paddingBottom: 10 },
  code: { fontFamily: mono, fontSize: 13, lineHeight: 19 },
})
