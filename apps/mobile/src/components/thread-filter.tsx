import {
  allEnvironments,
  type EnvironmentFilter,
  pickedEnvironmentIds,
  pickEnvironment,
} from "@shared/environmentFilter.ts"
import { isGroupPicked, pickProjectGroup } from "@shared/projectGroups.ts"
import { useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { PressableScale } from "@/components/motion"
import { OptionRow, Section, Sheet } from "@/components/sheet"
import { Button } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { serverName, useShownServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { pickedGroups, projectChoices } from "@/lib/thread-filter"
import { usePreferences } from "@/stores/preferences"
import { useThreads } from "@/stores/threads"

export interface FilterChoice {
  readonly key: string
  readonly label: string
  readonly offline: boolean
  readonly selected: boolean
  readonly pick: () => void
}

export interface ThreadFilterMenu {
  /** All servers, one per server, then Hide offline. Empty with one paired server, which leaves nothing to narrow. */
  readonly servers: readonly FilterChoice[]
  /** All projects, then one per repository with a project on a shown server. */
  readonly projects: readonly FilterChoice[]
  /** The narrowing in effect, short enough for the pill. */
  readonly label: string
  readonly narrowed: boolean
}

const setServers = (environmentFilter: EnvironmentFilter) => usePreferences.getState().set({ environmentFilter })
const setProjects = (projectIds: readonly string[]) => usePreferences.getState().set({ projectIds })

export const resetThreadFilter = () =>
  usePreferences.getState().set({ environmentFilter: allEnvironments, projectIds: [] })

/** The servers and projects the home list and search can narrow to, as the desktop sidebar's filter menu offers. */
export function useThreadFilterMenu(): ThreadFilterMenu {
  const servers = useConnection((state) => state.servers)
  const environmentFilter = usePreferences((state) => state.environmentFilter)
  const projectIds = usePreferences((state) => state.projectIds)
  const projects = useThreads((state) => state.projects)
  const shown = useShownServers()
  const pickedServers = pickedEnvironmentIds(
    environmentFilter,
    servers.map((server) => ({ id: server.id, offline: server.status === "offline" })),
  )
  const picked = pickedGroups({ servers: shown, projectIds }, projects)

  const serverChoices: FilterChoice[] =
    servers.length < 2
      ? []
      : [
          {
            key: "all",
            label: copy("mobile_home_all_servers"),
            offline: false,
            selected: pickedServers.size === 0,
            pick: () => setServers({ ...environmentFilter, environmentIds: [] }),
          },
          ...servers.map((server) => {
            const selected = pickedServers.has(server.id)
            return {
              key: server.id,
              label: serverName(server),
              offline: server.status === "offline",
              selected,
              pick: () => setServers(pickEnvironment(environmentFilter, server.id, !selected)),
            }
          }),
          {
            key: "hide-offline",
            label: copy("mobile_settings_hide_offline_servers"),
            offline: false,
            selected: environmentFilter.hideOffline,
            pick: () => setServers({ ...environmentFilter, hideOffline: !environmentFilter.hideOffline }),
          },
        ]

  const groupChoices = projectChoices(shown, projects).map((group): FilterChoice => {
    const selected = isGroupPicked(group, projectIds)
    return {
      key: group.key,
      label: group.projects[0].name,
      offline: false,
      selected,
      pick: () => setProjects(pickProjectGroup(projectIds, group, !selected)),
    }
  })

  const label = filterLabel(
    picked.map((group) => group.projects[0].name),
    shown === null ? null : servers.filter((server) => shown.has(server.id)).map(serverName),
    servers.map(serverName),
  )

  return {
    servers: serverChoices,
    projects: [
      {
        key: "all",
        label: copy("mobile_home_filter_all_projects"),
        offline: false,
        selected: picked.length === 0,
        pick: () => setProjects([]),
      },
      ...groupChoices,
    ],
    label,
    narrowed: shown !== null || picked.length > 0,
  }
}

/** The picked projects, else the shown servers (`null` when all are), else the one paired server or every thread. */
function filterLabel(projects: readonly string[], shown: readonly string[] | null, paired: readonly string[]) {
  if (projects.length === 1) return projects[0]
  if (projects.length > 1) return copy("mobile_home_filter_projects_count", { count: String(projects.length) })
  if (shown !== null)
    return shown.length === 1 ? shown[0] : copy("mobile_home_servers_count", { count: String(shown.length) })
  return paired.length === 1 ? paired[0] : copy("mobile_home_filter_all_threads")
}

/** Connected when any server the list shows is. */
function useShownConnected() {
  const shown = useShownServers()
  return useConnection((state) =>
    state.servers.some((server) => server.status === "connected" && (shown === null || shown.has(server.id))),
  )
}

/** The filter's pill: the shown servers' connection, the narrowing in effect, and a sheet to change it. */
export function ThreadFilterPill() {
  const theme = useTheme()
  const connected = useShownConnected()
  const menu = useThreadFilterMenu()
  const [open, setOpen] = useState(false)
  return (
    <>
      <PressableScale
        testID="thread-filter-pill"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_home_filter_title")}
        accessibilityValue={{ text: menu.label }}
        onPress={() => setOpen(true)}
        style={[styles.pill, { backgroundColor: menu.narrowed ? theme.surfaceStrong : theme.surface }]}
      >
        <View style={[styles.dot, { backgroundColor: connected ? theme.running : theme.textMuted }]} />
        <Text numberOfLines={1} style={[styles.label, { color: theme.text }]}>
          {menu.label}
        </Text>
        <Icon
          name={menu.narrowed ? "FilterFill" : "ChevronDown"}
          size={16}
          color={menu.narrowed ? theme.text : theme.textMuted}
        />
      </PressableScale>
      <ThreadFilterSheet menu={menu} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/** The filter's choices as checkboxes. It stays open across picks, so several servers or projects can be picked. */
export function ThreadFilterSheet({ menu, open, onClose }: { menu: ThreadFilterMenu; open: boolean; onClose: () => void }) {
  return (
    <Sheet fit title={copy("mobile_home_filter_title")} open={open} onClose={onClose}>
      {menu.servers.length > 0 && <ChoiceSection title={copy("mobile_home_filter_servers")} choices={menu.servers} />}
      <ChoiceSection title={copy("mobile_home_filter_projects")} choices={menu.projects} />
      {menu.narrowed && (
        <Button
          testID="thread-filter-reset"
          label={copy("mobile_home_filter_reset")}
          icon="Refresh"
          style={styles.reset}
          onPress={resetThreadFilter}
        />
      )}
    </Sheet>
  )
}

function ChoiceSection({ title, choices }: { title: string; choices: readonly FilterChoice[] }) {
  return (
    <Section title={title} role="group">
      {choices.map((choice) => (
        <OptionRow
          key={choice.key}
          role="checkbox"
          label={choice.label}
          icon={choice.offline ? "CloudOff" : undefined}
          selected={choice.selected}
          onPress={choice.pick}
        />
      ))}
    </Section>
  )
}

const styles = StyleSheet.create({
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
  label: { flexShrink: 1, fontSize: 15, fontWeight: "500" },
  reset: { marginHorizontal: 16 },
})
