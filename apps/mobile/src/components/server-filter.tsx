import { type EnvironmentFilter, pickedEnvironmentIds, pickEnvironment } from "@shared/environmentFilter.ts"
import { ScrollView, StyleSheet, Text } from "react-native"
import { Icon } from "@/components/icon"
import { PressableScale } from "@/components/motion"
import { radius } from "@/constants/theme"
import { serverName, useSeveralServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { usePreferences } from "@/stores/preferences"

const setFilter = (environmentFilter: EnvironmentFilter) => usePreferences.getState().set({ environmentFilter })

export interface ServerChoice {
  readonly key: string
  readonly label: string
  readonly accessibilityLabel: string
  readonly offline: boolean
  readonly selected: boolean
  readonly pick: () => void
}

/**
 * The servers the home list and search can narrow to: All, then one per server. One paired server is the only
 * choice, already picked, since there is nothing to narrow.
 */
export function useServerChoices(): readonly ServerChoice[] {
  const servers = useConnection((state) => state.servers)
  const filter = usePreferences((state) => state.environmentFilter)
  const several = servers.length > 1
  const picked = pickedEnvironmentIds(
    filter,
    servers.map((server) => ({ id: server.id, offline: server.status === "offline" })),
  )
  const perServer = servers.map((server): ServerChoice => {
    const name = serverName(server)
    const offline = server.status === "offline"
    const selected = !several || picked.has(server.id)
    return {
      key: server.id,
      label: name,
      accessibilityLabel: offline ? copy("mobile_home_filter_server_offline", { server: name }) : name,
      offline,
      selected,
      pick: () => {
        if (several) setFilter(pickEnvironment(filter, server.id, !selected))
      },
    }
  })
  if (!several) return perServer
  const all = copy("mobile_home_filter_all")
  return [
    {
      key: "all",
      label: all,
      accessibilityLabel: all,
      offline: false,
      selected: picked.size === 0,
      pick: () => setFilter({ ...filter, environmentIds: [] }),
    },
    ...perServer,
  ]
}

/** A row of chips that narrows the list to the picked servers. Renders nothing while only one server is paired. */
export function ServerFilter() {
  const several = useSeveralServers()
  const choices = useServerChoices()
  if (!several) return null
  return (
    <ScrollView
      testID="server-filter"
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel={copy("mobile_home_filter_servers")}
      contentContainerStyle={styles.row}
    >
      {choices.map((choice) => (
        <Chip
          key={choice.key}
          testID={`server-filter-${choice.key}`}
          label={choice.label}
          accessibilityLabel={choice.accessibilityLabel}
          offline={choice.offline}
          selected={choice.selected}
          onPress={choice.pick}
        />
      ))}
    </ScrollView>
  )
}

function Chip({
  testID,
  label,
  accessibilityLabel = label,
  offline = false,
  selected,
  onPress,
}: {
  testID: string
  label: string
  accessibilityLabel?: string
  offline?: boolean
  selected: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const color = selected ? theme.background : theme.textResting
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      aria-selected={selected}
      hitSlop={{ top: 6, bottom: 6 }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: selected ? theme.text : theme.surface }]}
    >
      {offline && <Icon name="CloudOff" size={14} color={color} />}
      <Text numberOfLines={1} style={[styles.label, { color }]}>
        {label}
      </Text>
    </PressableScale>
  )
}

const CHIP_HEIGHT = 32

const styles = StyleSheet.create({
  row: { gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
  chip: {
    height: CHIP_HEIGHT,
    maxWidth: 200,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    borderRadius: radius.full,
  },
  label: { flexShrink: 1, fontSize: 14, fontWeight: "500" },
})
