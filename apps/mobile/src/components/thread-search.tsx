import type { Thread, ThreadSearchHit } from "@shared/domain.ts"
import { type ReactNode, useEffect, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { GroupedCard, SectionHeading } from "@/components/grouped-card"
import { Icon } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import { ThreadActionsTarget } from "@/components/thread-actions"
import { EmptyState, Notice } from "@/components/ui"
import { HIT, type Palette, radius } from "@/constants/theme"
import { threadStatusLabel } from "@/constants/thread-status"
import { useNow } from "@/hooks/use-now"
import { useShownServers } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { matchParts } from "@/lib/match-parts"
import { openThread } from "@/lib/navigation"
import { relativeTime } from "@/lib/relative-time"
import { hitsWithinServers, withinServers } from "@/lib/server-filter"
import { listedThreads, matchThreads, useThreads } from "@/stores/threads"

const THREAD_LIMIT = 20
const MESSAGE_LIMIT = 30
const MIN_MESSAGE_QUERY = 2
const DEBOUNCE_MS = 150

type MessageSearch =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | { readonly state: "done"; readonly hits: readonly ThreadSearchHit[] }
  | { readonly state: "error"; readonly error: string }

type Answer = { readonly query: string; readonly hits: readonly ThreadSearchHit[]; readonly error: string | null }

/** Messages that contain `query`, asked 150 ms after the last keystroke. An answer to an older query is dropped. */
function useMessageSearch(query: string): MessageSearch {
  const trimmed = query.trim()
  const [answer, setAnswer] = useState<Answer | null>(null)
  useEffect(() => {
    if (trimmed.length < MIN_MESSAGE_QUERY) return
    let current = true
    const timer = setTimeout(() => {
      call("search.threads", { query: trimmed, limit: MESSAGE_LIMIT }).then(
        (hits) => current && setAnswer({ query: trimmed, hits, error: null }),
        (cause: unknown) => current && setAnswer({ query: trimmed, hits: [], error: errorText(cause) }),
      )
    }, DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [trimmed])
  if (trimmed.length < MIN_MESSAGE_QUERY) return { state: "idle" }
  if (answer === null || answer.query !== trimmed) return { state: "loading" }
  return answer.error === null ? { state: "done", hits: answer.hits } : { state: "error", error: answer.error }
}

export type SearchScope = "all" | "threads" | "messages"

const scopes: readonly { value: SearchScope; label: string }[] = [
  { value: "all", label: copy("mobile_search_scope_all") },
  { value: "threads", label: copy("mobile_search_threads") },
  { value: "messages", label: copy("mobile_search_messages") },
]

/** Chips that narrow the results to thread titles or to messages. */
export function ScopeChips({ value, onChange }: { value: SearchScope; onChange: (scope: SearchScope) => void }) {
  const theme = useTheme()
  return (
    <View accessibilityRole="tablist" accessibilityLabel={copy("mobile_search_scope")} style={styles.chips}>
      {scopes.map((scope) => {
        const selected = scope.value === value
        return (
          <Pressable
            key={scope.value}
            testID={`search-scope-${scope.value}`}
            accessibilityRole="tab"
            accessibilityLabel={scope.label}
            aria-selected={selected}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange(scope.value)}
            style={({ pressed }) => [
              styles.chip,
              selected
                ? { backgroundColor: theme.text, borderColor: theme.text }
                : { backgroundColor: pressed ? theme.surface : theme.card, borderColor: theme.border },
            ]}
          >
            <Text style={[styles.chipLabel, { color: selected ? theme.background : theme.text }]}>{scope.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/**
 * Thread titles that match as the developer types, then messages from every thread. `scope` hides a section and
 * skips its search.
 */
export function SearchResults({
  query,
  scope = "all",
  nativeHeader = false,
  header,
}: {
  query: string
  scope?: SearchScope
  nativeHeader?: boolean
  header?: ReactNode
}) {
  const theme = useTheme()
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const servers = useShownServers()
  const listed = withinServers(servers, projects, listedThreads(byId))
  const threads =
    scope === "messages" ? [] : matchThreads(listed.threads, listed.projects, query).slice(0, THREAD_LIMIT)
  const search = useMessageSearch(scope === "threads" ? "" : query)
  const messages =
    search.state === "done" ? { ...search, hits: hitsWithinServers(servers, projects, search.hits) } : search
  const hits = messages.state === "done" ? messages.hits : []
  const empty = threads.length === 0 && hits.length === 0 && messages.state !== "loading"

  return (
    <ScrollView
      testID="search-results"
      style={nativeHeader ? { backgroundColor: theme.background } : undefined}
      contentInsetAdjustmentBehavior={nativeHeader ? "automatic" : "never"}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.list}
    >
      {header}
      {query.trim() === "" ? (
        <EmptyState icon="Search" title={copy("mobile_search_start")} />
      ) : (
        <>
          {threads.length > 0 && (
            <View>
              <SectionHeading label={copy("mobile_search_threads")} count={threads.length} />
              <GroupedCard>
                {threads.map((thread) => (
                  <ThreadHitRow key={thread.id} thread={thread} query={query} />
                ))}
              </GroupedCard>
            </View>
          )}
          {hits.length > 0 && (
            <View>
              <SectionHeading label={copy("mobile_search_messages")} count={hits.length} />
              <GroupedCard>
                {hits.map((hit) => (
                  <MessageHitRow key={hit.messageId} hit={hit} query={query} />
                ))}
              </GroupedCard>
            </View>
          )}
          {messages.state === "loading" && (
            <Reveal style={styles.status}>
              <Spinner color={theme.textMuted} />
              <Text style={[styles.statusText, { color: theme.textMuted }]}>{copy("mobile_search_searching")}</Text>
            </Reveal>
          )}
          {messages.state === "error" && <Notice text={messages.error} tone="danger" />}
          {empty && messages.state !== "error" && (
            <EmptyState icon="Search" title={copy("mobile_search_empty")} hint={copy("mobile_search_empty_hint")} />
          )}
        </>
      )}
    </ScrollView>
  )
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const theme = useTheme()
  return matchParts(text, query).map((part) =>
    part.match ? (
      <Text key={part.start} style={[styles.match, { color: theme.primary }]}>
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  )
}

const dotColor = (theme: Palette, status: Thread["status"]) =>
  status === "awaiting_approval" ? theme.attention : status === "running" ? theme.running : theme.surfaceStrong

/** A thread whose title or project matched: its status dot, the title, then the project and status or age. */
function ThreadHitRow({ thread, query }: { thread: Thread; query: string }) {
  const theme = useTheme()
  const now = useNow()
  const project = useThreads((state) => state.projects.find((entry) => entry.id === thread.projectId)?.name)
  const title = thread.title || copy("mobile_home_untitled")
  const status =
    thread.status === "awaiting_approval" || thread.status === "running"
      ? threadStatusLabel[thread.status]
      : relativeTime(thread.updatedAt, now)
  return (
    <ThreadActionsTarget
      thread={thread}
      testID={`thread-hit-${thread.id}`}
      accessibilityLabel={[title, project, status].filter(Boolean).join(", ")}
    >
      {(pressed) => (
        <View style={[styles.row, styles.threadRow, pressed && { backgroundColor: theme.surface }]}>
          <View style={[styles.dot, { backgroundColor: dotColor(theme, thread.status) }]} />
          <View style={styles.rowBody}>
            <Text numberOfLines={2} style={[styles.title, { color: theme.text }]}>
              <Highlighted text={title} query={query} />
            </Text>
            <Text numberOfLines={1} style={[styles.meta, { color: theme.textMuted }]}>
              {project !== undefined && project !== "" && (
                <>
                  <Highlighted text={project} query={query} />
                  {" · "}
                </>
              )}
              {status}
            </Text>
          </View>
        </View>
      )}
    </ThreadActionsTarget>
  )
}

/** A message that matched: the thread it is in, then the snippet with the match drawn in the primary color. */
function MessageHitRow({ hit, query }: { hit: ThreadSearchHit; query: string }) {
  const theme = useTheme()
  const now = useNow()
  const title = hit.threadTitle || copy("mobile_home_untitled")
  const time = relativeTime(hit.at, now)
  return (
    <Pressable
      testID={`message-hit-${hit.messageId}`}
      accessibilityRole="button"
      accessibilityLabel={[title, hit.snippet, time].join(", ")}
      onPress={() => openThread(hit.threadId)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <View style={styles.hitHeader}>
        <Icon name="Chat" size={13} color={theme.textMuted} />
        <Text numberOfLines={1} style={[styles.hitTitle, { color: theme.textMuted }]}>
          {title}
        </Text>
        <Text style={[styles.hitTime, { color: theme.textMuted }]}>{time}</Text>
      </View>
      <Text numberOfLines={3} style={[styles.snippet, { color: theme.text }]}>
        <Highlighted text={hit.snippet} query={query} />
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 4, paddingBottom: 4 },
  chip: {
    minHeight: HIT - 8,
    justifyContent: "center",
    paddingHorizontal: 16,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: { fontSize: 15, fontWeight: "500" },
  status: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 20 },
  statusText: { fontSize: 13 },
  row: { minHeight: HIT, paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  threadRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  dot: { width: 10, height: 10, borderRadius: radius.full, marginTop: 6 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 16, lineHeight: 22 },
  meta: { fontSize: 13, lineHeight: 18 },
  hitHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  hitTitle: { flex: 1, fontSize: 13 },
  hitTime: { fontSize: 13, fontVariant: ["tabular-nums"] },
  snippet: { fontSize: 15, lineHeight: 21 },
  match: { fontWeight: "700" },
})
