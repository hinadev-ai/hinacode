import { router, Stack } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Sheet, sheetStyles } from "@/components/sheet"
import { type FilterChoice, ThreadFilterPill, useThreadFilterMenu } from "@/components/thread-filter"
import { ConnectionBadge, IconButton } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

const homeActions = [
  { name: "add-project", label: copy("mobile_home_add_project"), icon: "FolderAdd", symbol: "folder.badge.plus", href: "/project/new" },
  { name: "add-server", label: copy("mobile_settings_add_server"), icon: "Computer", symbol: "server.rack", href: "/server/new" },
] as const satisfies readonly { name: string; label: string; icon: IconName; symbol: string; href: string }[]

const menuActions = (choices: readonly FilterChoice[]) =>
  choices.map((choice) => (
    <Stack.Toolbar.MenuAction
      key={choice.key}
      isOn={choice.selected}
      icon={choice.offline ? "icloud.slash" : undefined}
      onPress={choice.pick}
    >
      {choice.label}
    </Stack.Toolbar.MenuAction>
  ))

/** The filter pill and the list's actions as iOS toolbar menus, so the system draws their glass capsules. */
export function HomeToolbar() {
  const connection = useConnection((state) => state.status)
  const menu = useThreadFilterMenu()
  return (
    <Stack.Toolbar placement="right">
      {connection !== "connected" && (
        <Stack.Toolbar.View hidesSharedBackground>
          <ConnectionBadge status={connection} />
        </Stack.Toolbar.View>
      )}
      <Stack.Toolbar.Menu
        accessibilityLabel={copy("mobile_home_filter_title")}
        variant={menu.narrowed ? "prominent" : "plain"}
        separateBackground
      >
        <Stack.Toolbar.Label>{menu.label}</Stack.Toolbar.Label>
        {menu.servers.length > 0 && (
          <Stack.Toolbar.Menu inline title={copy("mobile_home_filter_servers")}>
            {menuActions(menu.servers)}
          </Stack.Toolbar.Menu>
        )}
        <Stack.Toolbar.Menu inline title={copy("mobile_home_filter_projects")}>
          {menuActions(menu.projects)}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar.Menu>
      <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={copy("mobile_home_more")}>
        {homeActions.map((action) => (
          <Stack.Toolbar.MenuAction key={action.name} icon={action.symbol} onPress={() => router.push(action.href)}>
            {action.label}
          </Stack.Toolbar.MenuAction>
        ))}
      </Stack.Toolbar.Menu>
    </Stack.Toolbar>
  )
}

/** The same filter pill and actions as header buttons, each opening a sheet, where there is no glass toolbar. */
export function HomeHeaderButtons() {
  const theme = useTheme()
  const connection = useConnection((state) => state.status)
  const [actionsOpen, setActionsOpen] = useState(false)
  const go = (href: (typeof homeActions)[number]["href"]) => {
    setActionsOpen(false)
    router.push(href)
  }
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
      <Sheet fit title={copy("mobile_home_more")} open={actionsOpen} onClose={() => setActionsOpen(false)}>
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
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  more: { width: HIT, height: HIT, borderRadius: radius.full },
})
