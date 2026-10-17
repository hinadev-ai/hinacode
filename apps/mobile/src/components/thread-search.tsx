import type { ThreadSearchHit } from "@shared/domain.ts"
import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import Animated, { LayoutAnimationConfig, LinearTransition } from "react-native-reanimated"
import { Icon } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import {
  type GroupPosition,
  openThread,
  rowEntering,
  rowExiting,
  SectionLabel,
  ThreadRow,
} from "@/components/thread-row"
import { EmptyState, Notice } from "@/components/ui"
import { cssEase, duration } from "@/constants/motion"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { relativeTime } from "@/lib/relative-time"
import { matchThreads, useThreads } from "@/stores/threads"

const THREAD_LIMIT = 20
const MESSAGE_LIMIT = 30
const MIN_MESSAGE_QUERY = 2
const DEBOUNCE_MS = 150

export function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const theme = useTheme()
  const filled = value !== ""
  return (
    <View style={[styles.field, { backgroundColor: theme.surface }]}>
      <Icon name="RiSearchLine" size={18} color={theme.textMuted} />
      <TextInput
        testID="thread-search"
        accessibilityLabel={copy("mobile_search_placeholder")}
        value={value}
        onChangeText={onChange}
        placeholder={copy("mobile_search_placeholder")}
        placeholderTextColor={theme.textMuted}
        returnKeyType="search"
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text }]}
      />
      <Animated.View
        style={{
          pointerEvents: filled ? "auto" : "none",
          opacity: filled ? 1 : 0,
          transitionProperty: "opacity",
          transitionDuration: duration.fast,
          transitionTimingFunction: cssEase.out,
        }}
      >
        <Pressable
          testID="thread-search-clear"
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_search_clear")}
          accessibilityElementsHidden={!filled}
          importantForAccessibility={filled ? "auto" : "no-hide-descendants"}
          hitSlop={8}
          onPress={() => onChange("")}
          style={styles.clear}
        >
          <Icon name="RiCloseCircleFill" size={18} color={theme.textMuted} />
        </Pressable>
      </Animated.View>
    </View>
  )
}

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
  | { readonly kind: "thread"; readonly key: string; readonly threadId: string; readonly position: GroupPosition }
  | { readonly kind: "hit"; readonly key: string; readonly hit: ThreadSearchHit; readonly position: GroupPosition }

const positionIn = (index: number, length: number): GroupPosition => ({
  first: index === 0,
  last: index === length - 1,
})

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
    threads.forEach((thread, index) =>
      items.push({
        kind: "thread",
        key: `thread:${thread.id}`,
        threadId: thread.id,
        position: positionIn(index, threads.length),
      }),
    )
  }
  if (messages.state !== "idle" && (messages.state !== "done" || hits.length > 0)) {
    items.push({ kind: "label", key: "label:messages", label: copy("mobile_search_messages") })
    hits.forEach((hit, index) =>
      items.push({ kind: "hit", key: `hit:${hit.messageId}`, hit, position: positionIn(index, hits.length) }),
    )
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
          if (item.kind === "hit") return <MessageHitRow hit={item.hit} query={query} position={item.position} />
          const thread = byId[item.threadId]
          return thread === undefined ? null : <ThreadRow thread={thread} showProject position={item.position} />
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

function MessageHitRow({ hit, query, position }: { hit: ThreadSearchHit; query: string; position: GroupPosition }) {
  const theme = useTheme()
  const title = hit.threadTitle || copy("mobile_home_untitled")
  const time = relativeTime(hit.at)
  return (
    <Animated.View entering={rowEntering} exiting={rowExiting}>
      <Pressable
        testID={`message-hit-${hit.messageId}`}
        accessibilityRole="button"
        accessibilityLabel={[title, hit.snippet, time].join(", ")}
        onPress={() => openThread(hit.threadId)}
        style={({ pressed }) => [
          styles.hit,
          { backgroundColor: pressed ? theme.surfaceStrong : theme.surface },
          position.first && styles.first,
          position.last && styles.last,
        ]}
      >
        <View
          style={[
            styles.hitBody,
            !position.first && { borderTopWidth: StyleSheet.hairlineWidth },
            { borderColor: theme.border },
          ]}
        >
          <View style={styles.hitHeader}>
            <Text numberOfLines={1} style={[styles.hitTitle, { color: theme.text }]}>
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
        </View>
      </Pressable>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  field: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: radius.md,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 10 },
  clear: { padding: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  status: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 20 },
  statusText: { fontSize: 13 },
  hit: { paddingLeft: 14 },
  first: { borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  last: { borderBottomLeftRadius: radius.md, borderBottomRightRadius: radius.md },
  hitBody: { gap: 4, paddingVertical: 12, paddingRight: 14 },
  hitHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  hitTitle: { flex: 1, fontSize: 15, fontWeight: "500" },
  hitTime: { fontSize: 13, fontVariant: ["tabular-nums"] },
  snippet: { fontSize: 13, lineHeight: 18 },
  match: { fontWeight: "600" },
})
