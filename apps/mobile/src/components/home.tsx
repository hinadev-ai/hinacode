import type { Project, Thread } from "@shared/domain.ts"
import { router } from "expo-router"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { BackHandler, type FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import Animated, { LayoutAnimationConfig, useReducedMotion } from "react-native-reanimated"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Rotate, Spinner } from "@/components/motion"
import { SearchField } from "@/components/search-field"
import { HomeOverview } from "@/components/home-summary"
import { ServerMark } from "@/components/server-mark"
import { SectionLabel, ThreadRow } from "@/components/thread-row"
import { resetThreadFilter, ThreadFilterPill } from "@/components/thread-filter"
import { SearchResults } from "@/components/thread-search"
import { Button, EmptyState, IconButton, Notice, type Tab, UnderlineTabs } from "@/components/ui"
import { cssEase, duration, listEntering, listExiting, listLayout } from "@/constants/motion"
import { radius } from "@/constants/theme"
import { useProjectServer, useThreadFilter } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import type { HomeTab } from "@/lib/preferences"
import { createThread } from "@/lib/start-thread"
import { withinFilter } from "@/lib/thread-filter"
import { usePreferences } from "@/stores/preferences"
import {
  archivedThreads,
  inboxThreads,
  listedThreads,
  pinnedThreads,
  settledThreads,
  sortThreads,
  useThreads,
} from "@/stores/threads"

/**
 * Pull requests, New thread and Settings, in the sidebar's header. A thread over the tabs hides the tab bar, so these
 * go back down to the tab they name.
 */
export function HomeActions({ onNewThread }: { onNewThread: () => void }) {
  return (
    <View style={styles.actions}>
      <IconButton
        testID="pull-requests-button"
        icon="RiGitPullRequestLine"
        accessibilityLabel={copy("mobile_overview_pull_requests")}
        onPress={() => router.dismissTo("/pull-requests")}
      />
      <IconButton
        testID="new-thread-button"
        icon="Plus"
        accessibilityLabel={copy("mobile_home_new_thread")}
        onPress={onNewThread}
      />
      <IconButton
        testID="settings-button"
        icon="Settings"
        accessibilityLabel={copy("mobile_settings_title")}
        onPress={() => router.dismissTo("/settings")}
      />
    </View>
  )
}

/**
 * The thread list with its loading and empty states: the Threads tab on a phone, the sidebar in a wide window.
 * `selectedId` marks the thread open next to it.
 */
export function HomeContent({
  selectedId,
  searchable = false,
  transparent = false,
}: {
  selectedId?: string
  /** Shows a search field over the list, for the sidebar, which has no search tab beside it. */
  searchable?: boolean
  /** Lets the surface behind show through, for the floating glass sidebar. */
  transparent?: boolean
}) {
  const theme = useTheme()
  const loadStatus = useThreads((state) => state.status)
  const loadError = useThreads((state) => state.error)
  const hasProjects = useThreads((state) => state.projects.length > 0)
  const [query, setQuery] = useState("")
  const [searchShown, setSearchShown] = useState(true)
  const [searchHeight, setSearchHeight] = useState<number>()
  const reduced = useReducedMotion()

  useEffect(() => {
    if (query === "") return
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (router.canGoBack()) return false
      setQuery("")
      return true
    })
    return () => subscription.remove()
  }, [query])

  const loading = loadStatus === "loading" && !hasProjects
  const noProjects = loadStatus === "ready" && !hasProjects
  const status = loading ? (
    <Reveal style={styles.loading}>
      <Spinner size={20} color={theme.textMuted} />
      <Text style={{ color: theme.textMuted }}>{copy("mobile_home_loading")}</Text>
    </Reveal>
  ) : noProjects ? (
    <EmptyState
      icon="FolderAdd"
      title={copy("mobile_home_no_projects")}
      hint={copy("mobile_home_no_projects_hint")}
      action={
        <Button
          testID="add-project-button"
          label={copy("mobile_home_add_project")}
          icon="FolderAdd"
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
        icon="Refresh"
        style={styles.retry}
        onPress={() => void useThreads.getState().load()}
      />
    </View>
  )

  const filterRow = (
    <View style={styles.filter}>
      <ThreadFilterPill />
    </View>
  )

  if (!searchable) {
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

    return (
      <HomeList
        selectedId={selectedId}
        nativeHeader
        header={
          <>
            {notice}
            <HomeOverview />
          </>
        }
      />
    )
  }

  return (
    <View style={[styles.screen, { backgroundColor: transparent ? "transparent" : theme.background }]}>
      {notice}
      {status}
      {hasProjects && (
        <>
          <Animated.View
            style={[
              styles.searchClip,
              searchHeight !== undefined && {
                height: searchShown ? searchHeight : 0,
                opacity: searchShown ? 1 : 0,
                transitionProperty: ["height", "opacity"],
                transitionDuration: reduced ? 0 : duration.base,
                transitionTimingFunction: cssEase.out,
              },
            ]}
          >
            <View style={styles.search} onLayout={(event) => setSearchHeight(event.nativeEvent.layout.height)}>
              <SearchField
                testID="thread-search"
                value={query}
                onChange={setQuery}
                placeholder={copy("mobile_search_placeholder")}
                clearLabel={copy("mobile_search_clear")}
              />
            </View>
          </Animated.View>
          {query.trim() === "" ? (
            <HomeList selectedId={selectedId} header={filterRow} onScrollDirection={(up) => setSearchShown(up)} />
          ) : (
            <SearchResults query={query} header={filterRow} />
          )}
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
      readonly resettable?: boolean
    }

const threadItems = (prefix: string, threads: readonly Thread[], showProject: boolean): HomeItem[] =>
  threads.map((thread) => ({ kind: "thread", key: `${prefix}:${thread.id}`, thread, showProject }))

const threadIds = (items: readonly HomeItem[]): ReadonlySet<string> =>
  new Set(items.flatMap((item) => (item.kind === "thread" ? [item.thread.id] : [])))

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
  } else if (tab === "settled") {
    const settled = settledThreads(threads)
    if (settled.length === 0)
      items.push({
        kind: "empty",
        key: "empty:settled",
        icon: "CheckCircle",
        title: copy("mobile_home_settled_empty"),
        hint: copy("mobile_home_settled_empty_hint"),
      })
    items.push(...threadItems("thread", settled, true))
  } else if (tab === "archived") {
    const archived = archivedThreads(threads)
    if (archived.length === 0)
      items.push({
        kind: "empty",
        key: "empty:archived",
        icon: "Archive",
        title: copy("mobile_home_archived_empty"),
      })
    items.push(...threadItems("thread", archived, true))
  } else {
    if (projects.length === 0)
      items.push({
        kind: "empty",
        key: "empty:filtered",
        icon: "Filter",
        title: copy("mobile_home_filter_empty"),
        resettable: true,
      })
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

/** Points a scroll event must move before it counts as a direction, so a resting finger's jitter does not flicker. */
const SCROLL_INTENT = 4

function HomeList({
  selectedId,
  nativeHeader = false,
  header,
  onScrollDirection,
}: {
  selectedId?: string
  nativeHeader?: boolean
  header?: ReactNode
  /** Called with `true` when the list scrolls up or reaches the top, `false` when it scrolls down. */
  onScrollDirection?: (up: boolean) => void
}) {
  const theme = useTheme()
  const tab = usePreferences((state) => state.homeTab)
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const listed = withinFilter(useThreadFilter(), projects, listedThreads(byId))
  const items = homeItems(tab, listed.projects, listed.threads, collapsed)
  const [shown, setShown] = useState(() => ({ tab, threadIds: threadIds(items) }))
  const list = useRef<FlatList<HomeItem>>(null)
  const scrollY = useRef(0)
  const restoreY = useRef<number | null>(null)
  if (shown.tab !== tab) setShown({ tab, threadIds: threadIds(items) })

  const selectTab = (homeTab: HomeTab) => {
    restoreY.current = scrollY.current
    usePreferences.getState().set({ homeTab })
  }

  const toggle = (projectId: string) => {
    const next = new Set(collapsed)
    if (!next.delete(projectId)) next.add(projectId)
    setCollapsed(next)
  }

  // A tab swaps its rows at once, as on the desktop; only moves within a tab slide. The new tab's list opens where the
  // last one was scrolled, so the tab strip stays under the finger.
  return (
    <LayoutAnimationConfig key={tab} skipEntering>
      <Animated.FlatList
        testID="home-list"
        style={nativeHeader ? { backgroundColor: theme.background } : undefined}
        contentInsetAdjustmentBehavior={nativeHeader ? "automatic" : "never"}
        data={items}
        extraData={selectedId}
        keyExtractor={(item) => item.key}
        itemLayoutAnimation={listLayout}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        ref={list}
        onContentSizeChange={() => {
          if (restoreY.current === null) return
          list.current?.scrollToOffset({ offset: restoreY.current, animated: false })
          restoreY.current = null
        }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
          const y = contentOffset.y
          const moved = y - scrollY.current
          const pastEnd = y + layoutMeasurement.height > contentSize.height
          scrollY.current = y
          if (y <= 0) onScrollDirection?.(true)
          else if (!pastEnd && Math.abs(moved) > SCROLL_INTENT) onScrollDirection?.(moved < 0)
        }}
        scrollEventThrottle={16}
        contentContainerStyle={[styles.list, nativeHeader && styles.belowNewThread]}
        ListHeaderComponent={<>{header}</>}
        renderItem={({ item }) => (
          <HomeRow
            item={item}
            tab={tab}
            selectedId={selectedId}
            arrived={item.kind === "thread" && !shown.threadIds.has(item.thread.id)}
            onToggleProject={toggle}
            onSelectTab={selectTab}
          />
        )}
      />
    </LayoutAnimationConfig>
  )
}

function HomeRow({
  item,
  tab,
  selectedId,
  arrived,
  onToggleProject,
  onSelectTab,
}: {
  item: HomeItem
  tab: HomeTab
  selectedId?: string
  arrived: boolean
  onToggleProject: (projectId: string) => void
  onSelectTab: (tab: HomeTab) => void
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
          onChange={onSelectTab}
          accessibilityLabel={copy("mobile_home_tabs")}
          style={styles.tabs}
        />
      )
    case "thread": {
      const row = (
        <ThreadRow
          thread={item.thread}
          showProject={item.showProject}
          entering={arrived ? listEntering : undefined}
          exiting={listExiting}
        />
      )
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
      return (
        <EmptyState
          icon={item.icon}
          title={item.title}
          hint={item.hint}
          action={
            item.resettable === true && (
              <Button
                testID="thread-filter-empty-reset"
                label={copy("mobile_home_filter_reset")}
                onPress={resetThreadFilter}
              />
            )
          }
        />
      )
  }
}

const homeTabs: readonly Tab<HomeTab>[] = [
  { value: "inbox", label: copy("mobile_home_tab_inbox") },
  { value: "threads", label: copy("mobile_home_tab_threads") },
  { value: "settled", label: copy("mobile_home_tab_settled") },
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
            <Icon name="ChevronRight" size={16} color={theme.textMuted} />
          </Rotate>
          <Icon name="Folder" size={16} color={theme.textMuted} />
          <Text numberOfLines={1} style={[styles.projectName, { color: theme.text }]}>
            {project.name}
          </Text>
          <ServerMark server={server} />
        </Pressable>
        <IconButton
          testID={`new-thread-in-${project.id}`}
          icon="Plus"
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
  searchClip: { overflow: "hidden" },
  search: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  filter: { alignItems: "flex-start", paddingHorizontal: 8, paddingVertical: 6 },
  list: { paddingHorizontal: 8, paddingBottom: 32 },
  belowNewThread: { paddingBottom: 96 },
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
