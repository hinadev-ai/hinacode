import { router, Stack } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale } from "@/components/motion"
import { type ServerChoice, useServerChoices } from "@/components/server-filter"
import { OptionRow, Sheet, sheetStyles } from "@/components/sheet"
import { ConnectionBadge, IconButton } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useShownServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"

/** The server pill's label: the one shown server, every server, or how many are picked. */
function pillLabel(choices: readonly ServerChoice[]) {
  const servers = choices.filter((choice) => choice.key !== "all")
  if (servers.length === 1) return servers[0].label
  const picked = servers.filter((choice) => choice.selected)
  if (picked.length === 0) return copy("mobile_home_all_servers")
  return picked.length === 1 ? picked[0].label : copy("mobile_home_servers_count", { count: String(picked.length) })
}

/** Connected when any server the list shows is. */
function useShownConnected() {
  const shown = useShownServers()
  return useConnection((state) =>
    state.servers.some((server) => server.status === "connected" && (shown === null || shown.has(server.id))),
  )
}

const homeActions = [
  { name: "add-project", label: copy("mobile_home_add_project"), icon: "FolderAdd", symbol: "folder.badge.plus", href: "/project/new" },
  { name: "add-server", label: copy("mobile_settings_add_server"), icon: "Computer", symbol: "server.rack", href: "/server/new" },
] as const satisfies readonly { name: string; label: string; icon: IconName; symbol: string; href: string }[]

/** The server pill and the list's actions as iOS toolbar menus, so the system draws their glass capsules. */
export function HomeToolbar() {
  const connection = useConnection((state) => state.status)
  const choices = useServerChoices()
  return (
    <Stack.Toolbar placement="right">
      {connection !== "connected" && (
        <Stack.Toolbar.View hidesSharedBackground>
          <ConnectionBadge status={connection} />
        </Stack.Toolbar.View>
      )}
      <Stack.Toolbar.Menu accessibilityLabel={copy("mobile_home_filter_servers")} separateBackground>
        <Stack.Toolbar.Label>{pillLabel(choices)}</Stack.Toolbar.Label>
        {choices.map((choice) => (
          <Stack.Toolbar.MenuAction
            key={choice.key}
            isOn={choice.selected}
            icon={choice.offline ? "icloud.slash" : undefined}
            onPress={choice.pick}
          >
            {choice.label}
          </Stack.Toolbar.MenuAction>
        ))}
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

/** The same server pill and actions as header buttons, each opening a sheet, where there is no glass toolbar. */
export function HomeHeaderButtons() {
  const theme = useTheme()
  const connection = useConnection((state) => state.status)
  const connected = useShownConnected()
  const choices = useServerChoices()
  const [open, setOpen] = useState<"servers" | "actions" | null>(null)
  const close = () => setOpen(null)
  const go = (href: (typeof homeActions)[number]["href"]) => {
    close()
    router.push(href)
  }
  return (
    <View style={styles.row}>
      {connection !== "connected" && <ConnectionBadge status={connection} />}
      <PressableScale
        testID="server-pill"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_home_filter_servers")}
        accessibilityValue={{ text: pillLabel(choices) }}
        onPress={() => setOpen("servers")}
        style={[styles.pill, { backgroundColor: theme.surface }]}
      >
        <View style={[styles.dot, { backgroundColor: connected ? theme.running : theme.textMuted }]} />
        <Text numberOfLines={1} style={[styles.pillLabel, { color: theme.text }]}>
          {pillLabel(choices)}
        </Text>
        <Icon name="ChevronDown" size={16} color={theme.textMuted} />
      </PressableScale>
      <IconButton
        testID="home-more"
        icon="More"
        accessibilityLabel={copy("mobile_home_more")}
        onPress={() => setOpen("actions")}
        style={[styles.more, { backgroundColor: theme.surface }]}
      />
      <Sheet fit title={copy("mobile_home_filter_servers")} open={open === "servers"} onClose={close}>
        <View role="radiogroup" accessibilityLabel={copy("mobile_home_filter_servers")}>
          {choices.map((choice) => (
            <OptionRow
              key={choice.key}
              label={choice.label}
              icon={choice.offline ? "CloudOff" : undefined}
              selected={choice.selected}
              onPress={choice.pick}
            />
          ))}
        </View>
      </Sheet>
      <Sheet fit title={copy("mobile_home_more")} open={open === "actions"} onClose={close}>
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
  pill: {
    height: HIT,
    maxWidth: 180,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 14,
    paddingRight: 12,
    borderRadius: radius.full,
  },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  pillLabel: { flexShrink: 1, fontSize: 15, fontWeight: "500" },
  more: { width: HIT, height: HIT, borderRadius: radius.full },
})
