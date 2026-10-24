import { StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { useTheme } from "@/hooks/use-theme"
import { serverName, useSeveralServers } from "@/hooks/use-server"
import type { Server } from "@/lib/connection"
import { copy } from "@/lib/copy"

const statusLabel = {
  connecting: copy("mobile_connection_connecting"),
  offline: copy("mobile_connection_offline"),
  unauthorized: copy("mobile_connection_unauthorized"),
} as const

/** Where something lives, for a screen reader: `On studio`, or `On studio, Reconnecting` while it is away. */
export function serverLabel(server: Server) {
  const name = serverName(server)
  return server.status === "connected"
    ? copy("mobile_server_mark", { server: name })
    : copy("mobile_server_mark_away", { server: name, status: statusLabel[server.status] })
}

/**
 * The server something lives on, as a muted icon and name for a meta line. The icon turns into a dropped link
 * while the server is not connected. Renders nothing while only one server is paired.
 */
export function ServerMark({ server }: { server: Server | undefined }) {
  const theme = useTheme()
  const several = useSeveralServers()
  if (!several || server === undefined) return null
  return (
    <View accessible accessibilityLabel={serverLabel(server)} style={styles.mark}>
      <Icon
        name={server.status === "connected" ? "RiComputerLine" : "RiWifiOffLine"}
        size={12}
        color={theme.textMuted}
      />
      <Text numberOfLines={1} style={[styles.name, { color: theme.textMuted }]}>
        {serverName(server)}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  mark: { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 1, minWidth: 0, maxWidth: "40%" },
  name: { fontSize: 13, lineHeight: 18, flexShrink: 1 },
})
