import type { Project, Thread } from "@shared/domain.ts"
import { router, Stack } from "expo-router"
import { type ReactNode, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import Animated, { LayoutAnimationConfig, LinearTransition } from "react-native-reanimated"
import { liquidGlass } from "@/components/glass"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Rotate, Spinner } from "@/components/motion"
import { SearchField } from "@/components/search-field"
import { ServerMark } from "@/components/server-mark"
import { SectionLabel, ThreadRow } from "@/components/thread-row"
import { SearchResults } from "@/components/thread-search"
import { Button, EmptyState, IconButton, Notice, type Tab, UnderlineTabs } from "@/components/ui"
import { duration } from "@/constants/motion"
import { radius } from "@/constants/theme"
import { useProjectServer } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import type { HomeTab } from "@/lib/preferences"
import { createThread } from "@/lib/start-thread"
import { usePreferences } from "@/stores/preferences"
import { archivedThreads, inboxThreads, pinnedThreads, sortThreads, useThreads } from "@/stores/threads"

/** Overview, New thread and Settings, in the home screen's header or the sidebar's. */
export function HomeActions({ onNewThread }: { onNewThread: () => void }) {
  return (
    <View style={styles.actions}>
      <IconButton
        testID="overview-button"
        icon="RiDashboardLine"
        accessibilityLabel={copy("mobile_home_overview")}
        onPress={() => router.push("/overview")}
      />
      <IconButton
        testID="new-thread-button"
        icon="RiAddLine"
        accessibilityLabel={copy("mobile_home_new_thread")}
        onPress={onNewThread}
      />
      <IconButton
        testID="settings-button"
        icon="RiSettings3Line"
        accessibilityLabel={copy("mobile_home_settings")}
        onPress={() => router.push("/settings")}
      />
    </View>
  )
}

/**
 * The same three actions as native iOS toolbar items, so the system draws them and they take the Liquid Glass
 * capsules on iOS 26. There the bottom toolbar also hosts the search field, with New thread beside it. Older
 * iOS keeps every action in the header and the search under the title.
 */
export function HomeToolbars({ onNewThread }: { onNewThread: () => void }) {
  const overview = (
    <Stack.Toolbar.Button
      icon="square.grid.2x2"
      accessibilityLabel={copy("mobile_home_overview")}
      onPress={() => router.push("/overview")}
    >
      {copy("mobile_home_overview")}
    </Stack.Toolbar.Button>
  )
  const settings = (
    <Stack.Toolbar.Button
      icon="gearshape"
      accessibilityLabel={copy("mobile_home_settings")}
      onPress={() => router.push("/settings")}
    >
      {copy("mobile_home_settings")}
    </Stack.Toolbar.Button>
  )
  if (!liquidGlass)
    return (
      <Stack.Toolbar placement="right">
        {overview}
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          accessibilityLabel={copy("mobile_home_new_thread")}
          onPress={onNewThread}
        >
          {copy("mobile_home_new_thread")}
        </Stack.Toolbar.Button>
        {settings}
      </Stack.Toolbar>
    )
  return (
    <>
      <Stack.Toolbar placement="right">
        {overview}
        {settings}
      </Stack.Toolbar>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.SearchBarSlot separateBackground />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          variant="prominent"
          accessibilityLabel={copy("mobile_home_new_thread")}
          onPress={onNewThread}
        >
          {copy("mobile_home_new_thread")}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
    </>
  )
}

/**
 * The thread list with its search, loading and empty states: the whole home screen on a phone, the sidebar in a
 * wide window. `selectedId` marks the thread open next to it. With `search`, the platform's own search field owns
 * the query and the built-in one is not shown.
 */
export function HomeContent({
  selectedId,
  search,
  transparent = false,
}: {
  selectedId?: string
  search?: { readonly query: string; readonly onChange: (query: string) => void }
  /** Lets the surface behind show through, for the floating glass sidebar. */
  transparent?: boolean
}) {
  const theme = useTheme()
  const loadStatus = useThreads((state) => state.status)
  const loadError = useThreads((state) => state.error)
  const hasProjects = useThreads((state) => state.projects.length > 0)
  const [ownQuery, setOwnQuery] = useState("")
  const query = search?.query ?? ownQuery
  const setQuery = search?.onChange ?? setOwnQuery

  const loading = loadStatus === "loading" && !hasProjects
  const noProjects = loadStatus === "ready" && !hasProjects
  const status = loading ? (
    <Reveal style={styles.loading}>
      <Spinner size={20} color={theme.textMuted} />
      <Text style={{ color: theme.textMuted }}>{copy("mobile_home_loading")}</Text>
    </Reveal>
  ) : noProjects ? (
    <EmptyState
      icon="RiFolderAddLine"
      title={copy("mobile_home_no_projects")}
      hint={copy("mobile_home_no_projects_hint")}
      action={
        <Button
          testID="add-project-button"
          label={copy("mobile_home_add_project")}
          icon="RiFolderAddLine"
          variant="primary"
          onPress={() => router.push("/project/new")}
        />
      }
    />
  ) : null
  const notice = loadStatus === "error" && loadError !== null && (
    <View style={styles.notice}>
      <Notice text={loadError} tone="danger" />
      <Button
        label={copy("mobile_home_retry")}
        icon="RiRefreshLine"
        style={styles.retry}
        onPress={() => void useThreads.getState().load()}
      />
    </View>
  )

  if (search !== undefined) {
    if (!hasProjects)
      return (
        <ScrollView
          style={[styles.screen, { backgroundColor: theme.background }]}
          contentInsetAdjustmentBehavior="automatic"
        >
          {notice}
          {status}
        </ScrollView>
      )

    return query.trim() === "" ? (
      <HomeList selectedId={selectedId} nativeHeader header={notice} />
    ) : (
      <SearchResults query={query} nativeHeader header={notice} />
    )
  }

  return (
    <View style={[styles.screen, { backgroundColor: transparent ? "transparent" : theme.background }]}>
      {notice}
      {status}
      {hasProjects && (
        <>
          <View style={styles.search}>
            <SearchField
              testID="thread-search"
              value={query}
              onChange={setQuery}
              placeholder={copy("mobile_search_placeholder")}
              clearLabel={copy("mobile_search_clear")}
            />
          </View>
          {query.trim() === "" ? <HomeList selectedId={selectedId} /> : <SearchResults query={query} />}
        </>
      )}
    </View>
  )
}

type HomeItem =
  | { readonly kind: "label"; readonly key: string; readonly label: string }
  | { readonly kind: "tabs"; readonly key: string }
  | { readonly kind: "thread"; readonly key: string; readonly thread: Thread; readonly showProject: boolean }
  | { readonly kind: "project"; readonly key: string; readonly project: Project; readonly open: boolean }
  | { readonly kind: "note"; readonly key: string; readonly text: string }
  | {
      readonly kind: "empty"
      readonly key: string
      readonly icon: IconName
      readonly title: string
      readonly hint?: string
    }

const threadItems = (prefix: string, threads: readonly Thread[], showProject: boolean): HomeItem[] =>
  threads.map((thread) => ({ kind: "thread", key: `${prefix}:${thread.id}`, thread, showProject }))

function homeItems(
  tab: HomeTab,
  projects: readonly Project[],
  threads: readonly Thread[],
  collapsed: ReadonlySet<string>,
): HomeItem[] {
  const pinned = pinnedThreads(threads)
  const items: HomeItem[] = []
  if (pinned.length > 0) {
    items.push({ kind: "label", key: "label:pinned", label: copy("mobile_home_pinned") })
    items.push(...threadItems("pinned", pinned, true))
  }
  items.push({ kind: "tabs", key: "tabs" })

  if (tab === "inbox") {
    const inbox = inboxThreads(threads)
    if (inbox.length === 0)
      items.push({
        kind: "empty",
        key: "empty:inbox",
        icon: "RiInboxLine",
        title: copy("mobile_home_inbox_empty"),
        hint: copy("mobile_home_inbox_empty_hint"),
      })
    items.push(...threadItems("thread", inbox, true))
  } else if (tab === "archived") {
    const archived = archivedThreads(threads)
    if (archived.length === 0)
      items.push({
        kind: "empty",
        key: "empty:archived",
        icon: "RiArchiveLine",
        title: copy("mobile_home_archived_empty"),
      })
    items.push(...threadItems("thread", archived, true))
  } else {
    for (const project of projects) {
      const open = !collapsed.has(project.id)
      items.push({ kind: "project", key: `project:${project.id}`, project, open })
      if (!open) continue
      const active = threads.filter((thread) => thread.projectId === project.id && thread.status !== "archived")
      // Pinned threads are listed above the tabs, so a project of only pinned threads is not empty.
      if (active.length === 0)
        items.push({ kind: "note", key: `note:${project.id}`, text: copy("mobile_home_project_empty") })
      items.push(...threadItems("thread", sortThreads(active.filter((thread) => thread.pinnedAt === null)), false))
    }
  }
  return items
}

function HomeList({
  selectedId,
  nativeHeader = false,
  header,
}: {
  selectedId?: string
  nativeHeader?: boolean
  header?: ReactNode
}) {
  const theme = useTheme()
  const tab = usePreferences((state) => state.homeTab)
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const items = homeItems(tab, projects, Object.values(byId), collapsed)

  const toggle = (projectId: string) => {
    const next = new Set(collapsed)
    if (!next.delete(projectId)) next.add(projectId)
    setCollapsed(next)
  }

  // A tab swaps its rows at once, as on the desktop; only moves within a tab slide.
  return (
    <LayoutAnimationConfig key={tab} skipEntering>
      <Animated.FlatList
        testID="home-list"
        style={nativeHeader ? { backgroundColor: theme.background } : undefined}
        contentInsetAdjustmentBehavior={nativeHeader ? "automatic" : "never"}
        data={items}
        extraData={selectedId}
        keyExtractor={(item) => item.key}
        itemLayoutAnimation={LinearTransition.duration(duration.fast)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        ListHeaderComponent={<>{header}</>}
        renderItem={({ item }) => (
          <HomeRow item={item} tab={tab} selectedId={selectedId} onToggleProject={toggle} />
        )}
      />
    </LayoutAnimationConfig>
  )
}

function HomeRow({
  item,
  tab,
  selectedId,
  onToggleProject,
}: {
  item: HomeItem
  tab: HomeTab
  selectedId?: string
  onToggleProject: (projectId: string) => void
}) {
  const theme = useTheme()
  switch (item.kind) {
    case "label":
      return <SectionLabel label={item.label} />
    case "tabs":
      return (
        <UnderlineTabs
          tabs={homeTabs}
          value={tab}
          onChange={(homeTab) => usePreferences.getState().set({ homeTab })}
          accessibilityLabel={copy("mobile_home_tabs")}
          style={styles.tabs}
        />
      )
    case "thread": {
      const row = <ThreadRow thread={item.thread} showProject={item.showProject} />
      return item.thread.id === selectedId ? (
        <View style={[styles.selected, { backgroundColor: theme.surface }]}>{row}</View>
      ) : (
        row
      )
    }
    case "project":
      return <ProjectHeader project={item.project} open={item.open} onToggle={() => onToggleProject(item.project.id)} />
    case "note":
      return <Text style={[styles.note, { color: theme.textMuted }]}>{item.text}</Text>
    case "empty":
      return <EmptyState icon={item.icon} title={item.title} hint={item.hint} />
  }
}

const homeTabs: readonly Tab<HomeTab>[] = [
  { value: "inbox", label: copy("mobile_home_tab_inbox") },
  { value: "threads", label: copy("mobile_home_tab_threads") },
  { value: "archived", label: copy("mobile_home_tab_archived") },
]

/** A project's group in the Threads tab: tap to fold its threads away, or start a new one in it. */
function ProjectHeader({ project, open, onToggle }: { project: Project; open: boolean; onToggle: () => void }) {
  const theme = useTheme()
  const server = useProjectServer(project.id)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      openThread((await createThread(project)).id)
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setCreating(false)
    }
  }

  return (
    <View style={styles.project}>
      <View style={styles.projectRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_home_toggle_project", { project: project.name })}
          aria-expanded={open}
          onPress={onToggle}
          style={({ pressed }) => [styles.projectToggle, pressed && { backgroundColor: theme.surface }]}
        >
          <Rotate turned={open}>
            <Icon name="RiArrowRightSLine" size={16} color={theme.textMuted} />
          </Rotate>
          <Icon name="RiFolder3Line" size={16} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.projectName, { color: theme.text }]}>
            {project.name}
          </Text>
          <ServerMark server={server} />
        </Pressable>
        <IconButton
          testID={`new-thread-in-${project.id}`}
          icon="RiAddLine"
          accessibilityLabel={copy("mobile_home_new_in_project", { project: project.name })}
          busy={creating}
          onPress={() => void create()}
        />
      </View>
      {error !== null && <Notice text={error} tone="danger" />}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  actions: { flexDirection: "row" },
  notice: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  retry: { alignSelf: "flex-start" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 32 },
  search: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  list: { paddingHorizontal: 8, paddingBottom: 32 },
  tabs: { marginTop: 4, marginBottom: 6 },
  selected: { borderRadius: radius.md },
  project: { gap: 6, paddingTop: 6 },
  projectRow: { flexDirection: "row", alignItems: "center" },
  projectToggle: {
    flex: 1,
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 6,
    borderRadius: radius.md,
  },
  projectName: { flexShrink: 1, fontSize: 15, fontWeight: "500" },
  note: { fontSize: 13, paddingLeft: 34, paddingBottom: 8 },
})
