import type { Project, Thread } from "@shared/domain.ts"
import { router, Stack } from "expo-router"
import { useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import Animated, { LayoutAnimationConfig, LinearTransition } from "react-native-reanimated"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { type GroupPosition, openThread, SectionLabel, ThreadRow } from "@/components/thread-row"
import { SearchField, SearchResults } from "@/components/thread-search"
import {
  Button,
  ConnectionBadge,
  EmptyState,
  IconButton,
  Notice,
  type Segment,
  SegmentedControl,
} from "@/components/ui"
import { duration } from "@/constants/motion"
import { HIT } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import type { HomeTab } from "@/lib/preferences"
import { usePreferences } from "@/stores/preferences"
import { archivedThreads, inboxThreads, needsHuman, pinnedThreads, sortThreads, useThreads } from "@/stores/threads"

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
                <SearchField value={query} onChange={setQuery} />
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
  | { readonly kind: "tabs"; readonly key: string; readonly count: number }
  | {
      readonly kind: "thread"
      readonly key: string
      readonly thread: Thread
      readonly showProject: boolean
      readonly position: GroupPosition
    }
  | { readonly kind: "project"; readonly key: string; readonly project: Project }
  | { readonly kind: "note"; readonly key: string; readonly text: string }
  | {
      readonly kind: "empty"
      readonly key: string
      readonly icon: IconName
      readonly title: string
      readonly hint?: string
    }

const threadItems = (prefix: string, threads: readonly Thread[], showProject: boolean): HomeItem[] =>
  threads.map((thread, index) => ({
    kind: "thread",
    key: `${prefix}:${thread.id}`,
    thread,
    showProject,
    position: { first: index === 0, last: index === threads.length - 1 },
  }))

function homeItems(tab: HomeTab, projects: readonly Project[], threads: readonly Thread[]): HomeItem[] {
  const pinned = pinnedThreads(threads)
  const items: HomeItem[] = []
  if (pinned.length > 0) {
    items.push({ kind: "label", key: "label:pinned", label: copy("mobile_home_pinned") })
    items.push(...threadItems("pinned", pinned, true))
  }
  items.push({ kind: "tabs", key: "tabs", count: threads.filter(needsHuman).length })

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
      items.push({ kind: "project", key: `project:${project.id}`, project })
      const own = sortThreads(
        threads.filter((thread) => thread.projectId === project.id && thread.status !== "archived"),
      )
      if (own.length === 0)
        items.push({ kind: "note", key: `note:${project.id}`, text: copy("mobile_home_project_empty") })
      items.push(...threadItems("thread", own, false))
    }
  }
  return items
}

function HomeList() {
  const tab = usePreferences((state) => state.homeTab)
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const items = homeItems(tab, projects, Object.values(byId))

  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.FlatList
        testID="home-list"
        data={items}
        keyExtractor={(item) => item.key}
        itemLayoutAnimation={LinearTransition.duration(duration.fast)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        renderItem={({ item }) => <HomeRow item={item} tab={tab} />}
      />
    </LayoutAnimationConfig>
  )
}

function HomeRow({ item, tab }: { item: HomeItem; tab: HomeTab }) {
  const theme = useTheme()
  switch (item.kind) {
    case "label":
      return <SectionLabel label={item.label} />
    case "tabs":
      return <HomeTabs tab={tab} count={item.count} />
    case "thread":
      return <ThreadRow thread={item.thread} showProject={item.showProject} position={item.position} />
    case "project":
      return <ProjectHeader project={item.project} />
    case "note":
      return <Text style={[styles.note, { color: theme.textMuted }]}>{item.text}</Text>
    case "empty":
      return <EmptyState icon={item.icon} title={item.title} hint={item.hint} />
  }
}

function HomeTabs({ tab, count }: { tab: HomeTab; count: number }) {
  const segments: readonly Segment<HomeTab>[] = [
    { value: "inbox", label: copy("mobile_home_tab_inbox"), count },
    { value: "projects", label: copy("mobile_home_tab_projects") },
    { value: "archived", label: copy("mobile_home_tab_archived") },
  ]
  return (
    <SegmentedControl
      segments={segments}
      value={tab}
      onChange={(homeTab) => usePreferences.getState().set({ homeTab })}
      accessibilityLabel={copy("mobile_home_tabs")}
      style={styles.tabs}
    />
  )
}

function ProjectHeader({ project }: { project: Project }) {
  const theme = useTheme()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = copy("mobile_home_new_in_project", { project: project.name })

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
        <Icon name="RiFolderLine" size={16} color={theme.textMuted} />
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.projectName, { color: theme.text }]}>
          {project.name}
        </Text>
        {creating ? (
          <View accessibilityRole="progressbar" accessibilityLabel={label} style={styles.creating}>
            <Spinner size={18} color={theme.textMuted} />
          </View>
        ) : (
          <IconButton
            testID={`new-thread-in-${project.id}`}
            icon="RiAddLine"
            accessibilityLabel={label}
            onPress={() => void create()}
          />
        )}
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
  search: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  tabs: { marginTop: 12, marginBottom: 12 },
  project: { gap: 6, paddingTop: 12, paddingBottom: 4 },
  projectRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 4 },
  projectName: { flex: 1, fontSize: 15, fontWeight: "600" },
  creating: { width: HIT, height: HIT, alignItems: "center", justifyContent: "center" },
  note: { fontSize: 13, paddingLeft: 26, paddingBottom: 8 },
})
