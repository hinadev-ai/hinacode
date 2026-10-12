import type { Project, Thread } from "@shared/domain.ts"
import { router, Stack } from "expo-router"
import { useMemo, useState } from "react"
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from "react-native"
import { Button, ConnectionBadge, Notice, Pill, threadStatusLabel, ThreadStatusPill } from "@/components/ui"
import { HIT } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, disconnect, useConnection } from "@/lib/connection"
import { clearTarget } from "@/lib/storage"
import { sortThreads, useThreads } from "@/stores/threads"

export default function ThreadListScreen() {
  const theme = useTheme()
  const status = useConnection((state) => state.status)
  const { projects, byId, status: loadStatus, error } = useThreads()

  const sections = useMemo(() => {
    const threads = Object.values(byId)
    return projects.map((project) => ({
      project,
      data: sortThreads(threads.filter((thread) => thread.projectId === project.id)),
    }))
  }, [projects, byId])

  return (
    <>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <View style={styles.headerSide}>
              <ConnectionBadge status={status} />
            </View>
          ),
          headerRight: () => (
            <Button
              testID="disconnect-button"
              label="Disconnect"
              variant="ghost"
              onPress={() => void clearTarget().then(disconnect)}
            />
          ),
        }}
      />
      <SectionList
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.list}
        sections={sections}
        keyExtractor={(thread) => thread.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          loadStatus === "error" && error !== null ? <Notice text={error} tone="danger" /> : null
        }
        ListEmptyComponent={
          loadStatus === "ready" ? (
            <Text style={[styles.empty, { color: theme.textMuted }]}>
              No projects yet. Add one on the desktop first.
            </Text>
          ) : null
        }
        renderSectionHeader={({ section }) => <ProjectHeader project={section.project} empty={section.data.length === 0} />}
        renderItem={({ item }) => <ThreadRow thread={item} />}
      />
    </>
  )
}

function ProjectHeader({ project, empty }: { project: Project; empty: boolean }) {
  const theme = useTheme()
  const [creating, setCreating] = useState(false)
  const create = async () => {
    setCreating(true)
    try {
      const thread = await call("threads.create", { projectId: project.id })
      useThreads.getState().upsert(thread)
      router.push({ pathname: "/thread/[id]", params: { id: thread.id } })
    } catch (cause) {
      Alert.alert("Could not create a thread", cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCreating(false)
    }
  }
  return (
    <View style={styles.projectHeader}>
      <View style={styles.projectTitle}>
        <Text accessibilityRole="header" numberOfLines={1} style={[styles.projectName, { color: theme.text }]}>
          {project.name}
        </Text>
        {empty && <Text style={{ color: theme.textMuted, fontSize: 13 }}>No threads</Text>}
      </View>
      <Button
        testID={`new-thread-${project.id}`}
        label="New thread"
        accessibilityLabel={`New thread in ${project.name}`}
        busy={creating}
        onPress={() => void create()}
      />
    </View>
  )
}

function ThreadRow({ thread }: { thread: Thread }) {
  const theme = useTheme()
  return (
    <Pressable
      testID={`thread-row-${thread.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${thread.title}, ${thread.provider}, ${threadStatusLabel(thread.status)}`}
      onPress={() => router.push({ pathname: "/thread/[id]", params: { id: thread.id } })}
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.surfaceStrong : theme.surface, borderColor: theme.border },
      ]}
    >
      <Text numberOfLines={2} style={[styles.rowTitle, { color: theme.text }]}>
        {thread.title || "Untitled"}
      </Text>
      <View style={styles.rowMeta}>
        <ThreadStatusPill status={thread.status} />
        <Pill label={thread.provider} tone="neutral" />
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  headerSide: { paddingHorizontal: 12 },
  list: { padding: 16, gap: 8 },
  empty: { fontSize: 15, padding: 20, textAlign: "center" },
  projectHeader: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 16, paddingBottom: 4 },
  projectTitle: { flex: 1, gap: 2 },
  projectName: { fontSize: 15, fontWeight: "700" },
  row: {
    minHeight: HIT + 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
    marginTop: 8,
  },
  rowTitle: { fontSize: 15, fontWeight: "500" },
  rowMeta: { flexDirection: "row", gap: 6 },
})
