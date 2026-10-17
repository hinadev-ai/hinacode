import type { ThreadSearchHit } from "@shared/domain.ts"
import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import Animated, { LayoutAnimationConfig, LinearTransition } from "react-native-reanimated"
import { Reveal, Spinner } from "@/components/motion"
import { SectionLabel, ThreadRow } from "@/components/thread-row"
import { EmptyState, Notice, ProviderMark } from "@/components/ui"
import { duration, listEntering, listExiting } from "@/constants/motion"
import { radius } from "@/constants/theme"
import { useNow } from "@/hooks/use-now"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { openThread } from "@/lib/navigation"
import { relativeTime } from "@/lib/relative-time"
import { matchThreads, useThreads } from "@/stores/threads"

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

type SearchItem =
  | { readonly kind: "label"; readonly key: string; readonly label: string }
  | { readonly kind: "thread"; readonly key: string; readonly threadId: string }
  | { readonly kind: "hit"; readonly key: string; readonly hit: ThreadSearchHit }

/** Thread titles that match as the developer types, then messages from every thread. */
export function SearchResults({ query }: { query: string }) {
  const theme = useTheme()
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const threads = matchThreads(Object.values(byId), projects, query).slice(0, THREAD_LIMIT)
  const messages = useMessageSearch(query)
  const hits = messages.state === "done" ? messages.hits : []

  const items: SearchItem[] = []
  if (threads.length > 0) {
    items.push({ kind: "label", key: "label:threads", label: copy("mobile_search_threads") })
    for (const thread of threads) items.push({ kind: "thread", key: `thread:${thread.id}`, threadId: thread.id })
  }
  if (messages.state !== "idle" && (messages.state !== "done" || hits.length > 0)) {
    items.push({ kind: "label", key: "label:messages", label: copy("mobile_search_messages") })
    for (const hit of hits) items.push({ kind: "hit", key: `hit:${hit.messageId}`, hit })
  }

  const nothing =
    threads.length === 0 && (messages.state === "idle" || (messages.state === "done" && hits.length === 0))

  return (
    <LayoutAnimationConfig skipEntering>
      <Animated.FlatList
        testID="search-results"
        data={items}
        keyExtractor={(item) => item.key}
        itemLayoutAnimation={LinearTransition.duration(duration.fast)}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        renderItem={({ item }) => {
          if (item.kind === "label") return <SectionLabel label={item.label} />
          if (item.kind === "hit") return <MessageHitRow hit={item.hit} query={query} />
          const thread = byId[item.threadId]
          return thread === undefined ? null : <ThreadRow thread={thread} showProject />
        }}
        ListFooterComponent={
          messages.state === "loading" ? (
            <Reveal style={styles.status}>
              <Spinner color={theme.textMuted} />
              <Text style={[styles.statusText, { color: theme.textMuted }]}>{copy("mobile_search_searching")}</Text>
            </Reveal>
          ) : messages.state === "error" ? (
            <Notice text={messages.error} tone="danger" />
          ) : nothing ? (
            <EmptyState
              icon="RiSearchLine"
              title={copy("mobile_search_empty")}
              hint={copy("mobile_search_empty_hint")}
            />
          ) : null
        }
      />
    </LayoutAnimationConfig>
  )
}

/** Splits `text` around every case-insensitive occurrence of `query`. */
function emphasize(text: string, query: string) {
  const needle = query.trim().toLowerCase()
  const haystack = text.toLowerCase()
  const parts: { text: string; match: boolean }[] = []
  if (needle === "" || haystack.length !== text.length) return [{ text, match: false }]
  let start = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, start)) {
    if (at > start) parts.push({ text: text.slice(start, at), match: false })
    parts.push({ text: text.slice(at, at + needle.length), match: true })
    start = at + needle.length
  }
  if (start < text.length) parts.push({ text: text.slice(start), match: false })
  return parts
}

/** A message that matched, laid out like a thread row: the thread's mark, title and time, then the snippet. */
function MessageHitRow({ hit, query }: { hit: ThreadSearchHit; query: string }) {
  const theme = useTheme()
  const now = useNow()
  const provider = useThreads((state) => state.byId[hit.threadId]?.provider)
  const title = hit.threadTitle || copy("mobile_home_untitled")
  const time = relativeTime(hit.at, now)
  return (
    <Animated.View entering={listEntering} exiting={listExiting}>
      <Pressable
        testID={`message-hit-${hit.messageId}`}
        accessibilityRole="button"
        accessibilityLabel={[title, hit.snippet, time].join(", ")}
        onPress={() => openThread(hit.threadId)}
        style={({ pressed }) => [styles.hit, pressed && { backgroundColor: theme.surface }]}
      >
        <View style={styles.hitHeader}>
          {provider === undefined ? <View style={styles.markSpace} /> : <ProviderMark provider={provider} size={16} />}
          <Text numberOfLines={1} style={[styles.hitTitle, { color: theme.textResting }]}>
            {title}
          </Text>
          <Text style={[styles.hitTime, { color: theme.textMuted }]}>{time}</Text>
        </View>
        <Text numberOfLines={2} style={[styles.snippet, { color: theme.textMuted }]}>
          {emphasize(hit.snippet, query).map((part, index) =>
            part.match ? (
              <Text key={index} style={[styles.match, { color: theme.text }]}>
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )}
        </Text>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 8, paddingBottom: 32 },
  status: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 20 },
  statusText: { fontSize: 13 },
  hit: { borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
  hitHeader: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 22 },
  markSpace: { width: 16 },
  hitTitle: { flex: 1, fontSize: 16, lineHeight: 22 },
  hitTime: { fontSize: 13, fontVariant: ["tabular-nums"] },
  snippet: { fontSize: 13, lineHeight: 18, paddingLeft: 26 },
  match: { fontWeight: "600" },
})
