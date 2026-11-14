import { router, Stack } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Sheet, sheetStyles } from "@/components/sheet"
import { useSideRail } from "@/hooks/use-side-rail"
import { ThreadFilterPill, ThreadFilterSheet, useThreadFilterMenu } from "@/components/thread-filter"
import { ConnectionBadge, IconButton } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

const homeActions = [
  {
    name: "add-project",
    label: copy("mobile_home_add_project"),
    icon: "FolderAdd",
    symbol: "folder.badge.plus",
    href: "/project/new",
  },
  {
    name: "add-server",
    label: copy("mobile_settings_add_server"),
    icon: "Computer",
    symbol: "server.rack",
    href: "/server/new",
  },
] as const satisfies readonly { name: string; label: string; icon: IconName; symbol: string; href: string }[]

// FIXME: Each pick re-renders the iOS toolbar, which replaces a system menu and closes it mid-pick, so the filter opens a sheet.
export function HomeToolbar() {
  const railed = useSideRail() > 0
  const connection = useConnection((state) => state.status)
  const menu = useThreadFilterMenu()
  const [filterOpen, setFilterOpen] = useState(false)
  return (
    <>
      <Stack.Toolbar placement="right">
        {connection !== "connected" && (
          <Stack.Toolbar.View hidesSharedBackground>
            <ConnectionBadge status={connection} />
          </Stack.Toolbar.View>
        )}
        <Stack.Toolbar.Button
          accessibilityLabel={copy("mobile_home_filter_title")}
          variant={menu.narrowed ? "prominent" : "plain"}
          separateBackground
          onPress={() => setFilterOpen(true)}
        >
          <Stack.Toolbar.Label>{menu.label}</Stack.Toolbar.Label>
        </Stack.Toolbar.Button>
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={copy("mobile_home_more")} hidden={railed}>
          {homeActions.map((action) => (
            <Stack.Toolbar.MenuAction key={action.name} icon={action.symbol} onPress={() => router.push(action.href)}>
              {action.label}
            </Stack.Toolbar.MenuAction>
          ))}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <ThreadFilterSheet menu={menu} open={filterOpen} onClose={() => setFilterOpen(false)} />
    </>
  )
}

export function HomeHeaderButtons() {
  const theme = useTheme()
  const connection = useConnection((state) => state.status)
  const [actionsOpen, setActionsOpen] = useState(false)
  return (
    <View style={styles.row}>
      {connection !== "connected" && <ConnectionBadge status={connection} />}
      <ThreadFilterPill />
      <IconButton
        testID="home-more"
        icon="More"
        accessibilityLabel={copy("mobile_home_more")}
        onPress={() => setActionsOpen(true)}
        style={[styles.more, { backgroundColor: theme.surface }]}
      />
      <HomeActionsSheet open={actionsOpen} onClose={() => setActionsOpen(false)} />
    </View>
  )
}

export function HomeActionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme()
  const go = (href: (typeof homeActions)[number]["href"]) => {
    onClose()
    router.push(href)
  }
  return (
    <Sheet fit title={copy("mobile_home_more")} open={open} onClose={onClose}>
      <View>
        {homeActions.map((action) => (
          <Pressable
            key={action.name}
            testID={`home-action-${action.name}`}
            accessibilityRole="button"
            onPress={() => go(action.href)}
            style={({ pressed }) => [sheetStyles.option, pressed && { backgroundColor: theme.sheetRaised }]}
          >
            <Icon name={action.icon} size={18} color={theme.text} />
            <Text style={[sheetStyles.optionLabel, { color: theme.text }]}>{action.label}</Text>
          </Pressable>
        ))}
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  more: { width: HIT, height: HIT, borderRadius: radius.full },
})
