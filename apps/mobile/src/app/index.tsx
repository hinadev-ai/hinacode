import type { Project, Thread } from "@shared/domain.ts"
import { router, Stack } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { LayoutAnimationConfig, LinearTransition } from "react-native-reanimated"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Rotate, Spinner } from "@/components/motion"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { SearchField } from "@/components/search-field"
import { ServerMark } from "@/components/server-mark"
import { SectionLabel, ThreadRow } from "@/components/thread-row"
import { SearchResults } from "@/components/thread-search"
import { Button, ConnectionBadge, EmptyState, IconButton, Notice, type Tab, UnderlineTabs } from "@/components/ui"
import { duration } from "@/constants/motion"
import { radius } from "@/constants/theme"
import { useProjectServer } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import type { HomeTab } from "@/lib/preferences"
import { usePreferences } from "@/stores/preferences"
import { archivedThreads, inboxThreads, pinnedThreads, sortThreads, useThreads } from "@/stores/threads"

export default function HomeScreen() {
  const theme = useTheme()
  const connection = useConnection((state) => state.status)
  const loadStatus = useThreads((state) => state.status)
  const loadError = useThreads((state) => state.error)
  const hasProjects = useThreads((state) => state.projects.length > 0)
  const [query, setQuery] = useState("")
  const [newThreadOpen, setNewThreadOpen] = useState(false)

  const loading = loadStatus === "loading" && !hasProjects
  const noProjects = loadStatus === "ready" && !hasProjects

  return (
    <>
      <Stack.Screen
        options={{
          title: copy("mobile_home_title"),
          headerLeft:
            connection === "connected"
              ? undefined
              : () => (
                  <View style={styles.headerLeft}>
                    <ConnectionBadge status={connection} />
                  </View>
                ),
          headerRight: () => (
            <View style={styles.headerRight}>
              <IconButton
                testID="new-thread-button"
                icon="RiAddLine"
                accessibilityLabel={copy("mobile_home_new_thread")}
                onPress={() => setNewThreadOpen(true)}
              />
              <IconButton
                testID="settings-button"
                icon="RiSettings3Line"
                accessibilityLabel={copy("mobile_home_settings")}
                onPress={() => router.push("/settings")}
              />
            </View>
          ),
        }}
      />
      <View style={[styles.screen, { backgroundColor: theme.background }]}>
        {loadStatus === "error" && loadError !== null && (
          <View style={styles.notice}>
            <Notice text={loadError} tone="danger" />
            <Button
              label={copy("mobile_home_retry")}
              icon="RiRefreshLine"
              style={styles.retry}
              onPress={() => void useThreads.getState().load()}
            />
          </View>
        )}
        {loading ? (
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
        ) : (
          hasProjects && (
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
              {query.trim() === "" ? <HomeList /> : <SearchResults query={query} />}
            </>
          )
        )}
      </View>
      <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />
    </>
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

function HomeList() {
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
        data={items}
        keyExtractor={(item) => item.key}
        itemLayoutAnimation={LinearTransition.duration(duration.fast)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <HomeRow item={item} tab={tab} onToggleProject={toggle} />}
      />
    </LayoutAnimationConfig>
  )
}

function HomeRow({
  item,
  tab,
  onToggleProject,
}: {
  item: HomeItem
  tab: HomeTab
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
    case "thread":
      return <ThreadRow thread={item.thread} showProject={item.showProject} />
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
      const thread = await call("threads.create", { projectId: project.id })
      useThreads.getState().upsert(thread)
      openThread(thread.id)
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
          accessibilityState={{ expanded: open }}
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
  headerLeft: { paddingHorizontal: 4 },
  headerRight: { flexDirection: "row" },
  notice: { gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  retry: { alignSelf: "flex-start" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 32 },
  search: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 4 },
  list: { paddingHorizontal: 8, paddingBottom: 32 },
  tabs: { marginTop: 4, marginBottom: 6 },
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
