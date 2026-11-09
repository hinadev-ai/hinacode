import { Pressable, StyleSheet, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { GlassFill, liquidGlass } from "@/components/glass"
import { Icon } from "@/components/icon"
import { cssEase, duration } from "@/constants/motion"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { barTabs, type ThreadTab } from "@/lib/thread-tabs"

const BAR_PADDING = 3
const TAB_WIDTH = 56
const TAB_HEIGHT = 32
const TAB_SLOP = { top: (HIT - TAB_HEIGHT) / 2, bottom: (HIT - TAB_HEIGHT) / 2 }

/** The thread's views as icon tabs at the foot of the screen. */
export function ThreadControlBar({
  tab,
  onSelect,
}: {
  tab: ThreadTab
  onSelect: (tab: ThreadTab) => void
}) {
  const theme = useTheme()
  const reduced = useReducedMotion()
  const index = barTabs.findIndex((item) => item.value === tab)
  return (
    <View style={styles.wrap}>
      <View
        style={[
          styles.bar,
          liquidGlass ? styles.glass : [styles.solid, { backgroundColor: theme.card, borderColor: theme.border }],
        ]}
      >
        <GlassFill />
        <View accessibilityRole="tablist" accessibilityLabel={copy("mobile_thread_tabs")} style={styles.tabs}>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.thumb,
              {
                backgroundColor: theme.card,
                borderColor: theme.border,
                opacity: index === -1 ? 0 : 1,
                transform: [{ translateX: Math.max(index, 0) * TAB_WIDTH }],
                transitionProperty: "transform",
                transitionDuration: reduced ? 0 : duration.base,
                transitionTimingFunction: cssEase.out,
              },
            ]}
          />
          {barTabs.map((item) => {
            const selected = item.value === tab
            return (
              <Pressable
                key={item.value}
                testID={`tab-${item.value}`}
                accessibilityRole="tab"
                accessibilityLabel={item.label}
                aria-selected={selected}
                hitSlop={TAB_SLOP}
                onPress={() => onSelect(item.value)}
                style={styles.tab}
              >
                <Icon name={item.icon} size={18} color={selected ? theme.text : theme.textMuted} />
              </Pressable>
            )
          })}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 4, gap: 8, alignItems: "center" },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: BAR_PADDING,
    borderRadius: radius.full,
  },
  glass: { overflow: "hidden" },
  solid: { borderWidth: StyleSheet.hairlineWidth, boxShadow: "0 4px 16px rgba(0, 0, 0, 0.06)" },
  tabs: { flexDirection: "row" },
  tab: { width: TAB_WIDTH, height: TAB_HEIGHT, alignItems: "center", justifyContent: "center" },
  thumb: {
    position: "absolute",
    width: TAB_WIDTH,
    height: TAB_HEIGHT,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.12)",
  },
})
