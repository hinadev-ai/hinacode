import { Stack, useGlobalSearchParams } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { useReducedMotion } from "react-native-reanimated"
import { SafeAreaView } from "react-native-safe-area-context"
import { GlassFill, liquidGlass } from "@/components/glass"
import { HomeActions, HomeContent } from "@/components/home"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { ConnectionBadge, IconButton } from "@/components/ui"
import { cssEase, duration } from "@/constants/motion"
import { Colors } from "@/constants/theme"
import { SIDEBAR_WIDTH, useSidebar } from "@/hooks/use-split-layout"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

/**
 * The home list in a wide window. Beside the thread it pushes the thread over as it opens; over a portrait thread it
 * slides in above a scrim. It stays mounted while hidden, so it keeps its scroll and search.
 */
export function ThreadSidebar() {
  const { beside, open, toggle } = useSidebar()
  const reduced = useReducedMotion()
  // It comes in on the sheets' curve and leaves a little quicker. Under Reduce Motion it moves at once and the scrim
  // still fades, as in `lib/motion.tsx`. CSS transitions, because that API animates neither width nor x.
  const fade = { transitionDuration: open ? duration.sheet : duration.base, transitionTimingFunction: cssEase.drawer }
  const slide = { ...fade, transitionDuration: reduced ? 0 : fade.transitionDuration }

  if (beside)
    return (
      <Animated.View
        aria-hidden={!open}
        style={[styles.beside, { width: open ? SIDEBAR_WIDTH : 0, transitionProperty: "width", ...slide }]}
      >
        <ThreadList />
      </Animated.View>
    )

  return (
    <>
      <Animated.View
        aria-hidden={!open}
        pointerEvents={open ? "auto" : "none"}
        style={[styles.scrim, { opacity: open ? 0.5 : 0, transitionProperty: "opacity", ...fade }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_home_hide_list")}
          onPress={toggle}
          style={styles.fill}
        />
      </Animated.View>
      <Animated.View
        aria-hidden={!open}
        accessibilityViewIsModal={open}
        onAccessibilityEscape={toggle}
        style={[
          styles.over,
          { transform: [{ translateX: open ? 0 : -SIDEBAR_WIDTH }], transitionProperty: "transform", ...slide },
        ]}
      >
        <ThreadList />
      </Animated.View>
    </>
  )
}

/** The sidebar toggle as a native iOS header item, for screens that show the system header. */
export function SidebarToolbarButton() {
  const { open, toggle } = useSidebar()
  const label = copy(open ? "mobile_home_hide_list" : "mobile_home_show_list")
  return (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel={label} onPress={toggle}>
        {label}
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
  )
}

/** Shows or hides the thread list, from the top left of the detail side. */
export function SidebarButton() {
  const { open, toggle } = useSidebar()
  return (
    <IconButton
      testID="sidebar-button"
      icon="RiSideBarLine"
      accessibilityLabel={copy(open ? "mobile_home_hide_list" : "mobile_home_show_list")}
      onPress={toggle}
    />
  )
}

/** The list with the header the phone's home screen has. Floating over a thread, it is glass where iOS offers it. */
function ThreadList() {
  const theme = useTheme()
  const { beside } = useSidebar()
  const glass = !beside && liquidGlass
  const connection = useConnection((state) => state.status)
  // Thread, file and pull request routes all carry the thread's id.
  const { id } = useGlobalSearchParams<{ id?: string }>()
  const [newThreadOpen, setNewThreadOpen] = useState(false)

  return (
    <SafeAreaView
      edges={["top", "left"]}
      style={[
        styles.list,
        glass ? styles.glassList : { backgroundColor: theme.background, borderColor: theme.border },
      ]}
    >
      {glass && <GlassFill />}
      <View style={styles.header}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.title, { color: theme.text }]}>
          {copy("mobile_home_title")}
        </Text>
        {connection !== "connected" && <ConnectionBadge status={connection} />}
        <View style={styles.spacer} />
        <HomeActions onNewThread={() => setNewThreadOpen(true)} />
      </View>
      <HomeContent selectedId={id} transparent={glass} />
      <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // The list keeps its width and rides the closing edge out, instead of being squeezed.
  beside: { overflow: "hidden", alignItems: "flex-end" },
  // The scrim is dark in both themes, like the sheets'.
  scrim: { ...StyleSheet.absoluteFill, zIndex: 1, backgroundColor: Colors.dark.background },
  over: { position: "absolute", top: 0, bottom: 0, left: 0, zIndex: 2 },
  list: { flex: 1, width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth },
  glassList: { overflow: "hidden", borderColor: "transparent" },
  header: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 52, paddingLeft: 16, paddingRight: 4 },
  title: { flexShrink: 1, fontSize: 17, fontWeight: "600" },
  spacer: { flex: 1 },
})
