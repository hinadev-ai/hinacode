import type { FileSearchHit, FsEntry, Thread } from "@shared/domain.ts"
import { router } from "expo-router"
import { useEffect, useRef, useState } from "react"
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { FadeIn, Reveal, Spinner } from "@/components/motion"
import { SearchField } from "@/components/search-field"
import { Button, EmptyState, Notice } from "@/components/ui"
import { HIT, type Palette, mono } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, RpcError } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { basename, dirname, entryIcon } from "@/lib/file-kinds"
import { matchPaths, type PathMatch } from "@/lib/path-match"
import { useThreadRoot } from "@/stores/threads"

type GitStatus = NonNullable<FsEntry["gitStatus"]>

const statusLetter: Record<GitStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  untracked: "U",
  conflict: "C",
}

const statusColor = (theme: Palette): Record<GitStatus, string> => ({
  added: theme.running,
  modified: theme.attention,
  deleted: theme.danger,
  untracked: theme.running,
  conflict: theme.danger,
})

const statusLabel = (status: GitStatus) =>
  ({
    added: copy("mobile_files_status_added"),
    modified: copy("mobile_files_status_modified"),
    deleted: copy("mobile_files_status_deleted"),
    untracked: copy("mobile_files_status_untracked"),
    conflict: copy("mobile_files_status_conflict"),
  })[status]

const openFile = (threadId: string, path: string, line?: number) =>
  router.push({
    pathname: "/thread/[id]/file",
    params: line === undefined ? { id: threadId, path } : { id: threadId, path, line: String(line) },
  })

type Loaded<T> = { readonly value: T } | { readonly error: string; readonly tag?: string }

/** The thread's workspace: a folder listing, a path filter and a content search. */
export function FilesPanel({ thread }: { thread: Thread }) {
  const root = useThreadRoot(thread)
  const [query, setQuery] = useState("")
  const [searchContents, setSearchContents] = useState(false)
  const [files, setFiles] = useState<Loaded<readonly string[]> | null>(null)
  const filtering = query.trim() !== ""
  const wantFiles = filtering && files === null

  useEffect(() => {
    if (!wantFiles) return
    let current = true
    call("files.list", { threadId: thread.id }).then(
      (paths) => current && setFiles({ value: paths }),
      (cause) => current && setFiles({ error: errorText(cause) }),
    )
    return () => {
      current = false
    }
  }, [wantFiles, thread.id])

  const changeQuery = (next: string) => {
    setQuery(next)
    if (next.trim() !== "") return
    setSearchContents(false)
    // The agent keeps adding files, so each new search reads the list again.
    setFiles(null)
  }

  if (root === null) return <Loading label={copy("mobile_files_finding_workspace")} />
  return (
    <View style={styles.flex}>
      <View style={styles.search}>
        <SearchField
          testID="files-search"
          value={query}
          onChange={changeQuery}
          onSubmit={() => filtering && setSearchContents(true)}
          placeholder={copy("mobile_files_search_placeholder")}
          clearLabel={copy("mobile_files_clear_search")}
        />
      </View>
      <View style={[styles.flex, filtering && styles.hidden]}>
        <FolderBrowser key={root} root={root} threadId={thread.id} />
      </View>
      {filtering && (
        <PathSearch
          threadId={thread.id}
          query={query.trim()}
          files={files}
          onRetryFiles={() => setFiles(null)}
          searchContents={searchContents}
          onSearchContents={() => setSearchContents(true)}
        />
      )}
    </View>
  )
}

function FolderBrowser({ root, threadId }: { root: string; threadId: string }) {
  const theme = useTheme()
  const [stack, setStack] = useState<readonly string[]>([""])
  const folder = stack[stack.length - 1]
  const [listing, setListing] = useState<(Loaded<readonly FsEntry[]> & { folder: string }) | null>(null)
  const [revision, setRevision] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let current = true
    call("fs.list", { root, path: folder })
      .then(
        (entries) => current && setListing({ folder, value: entries }),
        (cause) => current && setListing({ folder, error: errorText(cause) }),
      )
      .finally(() => current && setRefreshing(false))
    return () => {
      current = false
    }
  }, [root, folder, revision])

  const shown = listing?.folder === folder ? listing : null
  const open = (entry: FsEntry) =>
    entry.kind === "dir" ? setStack([...stack, entry.path]) : openFile(threadId, entry.path)
  const reload = () => {
    setRefreshing(true)
    setRevision(revision + 1)
  }

  return (
    <View style={styles.flex}>
      <Breadcrumbs root={root} stack={stack} onSelect={(depth) => setStack(stack.slice(0, depth + 1))} />
      {shown === null ? (
        <Loading label={copy("mobile_files_loading")} />
      ) : "error" in shown ? (
        <Failure
          message={shown.error}
          onRetry={() => {
            setListing(null)
            setRevision(revision + 1)
          }}
        />
      ) : (
        <FadeIn key={folder} style={styles.flex}>
          <FlatList
            data={shown.value}
            keyExtractor={(entry) => entry.path}
            renderItem={({ item }) => <EntryRow entry={item} onPress={() => open(item)} />}
            ListEmptyComponent={<EmptyState icon="RiFolderOpenLine" title={copy("mobile_files_empty_folder")} />}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} tintColor={theme.textMuted} />}
            contentContainerStyle={styles.listContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          />
        </FadeIn>
      )}
    </View>
  )
}

function Breadcrumbs({
  root,
  stack,
  onSelect,
}: {
  root: string
  stack: readonly string[]
  onSelect: (depth: number) => void
}) {
  const theme = useTheme()
  const scroller = useRef<ScrollView>(null)
  const rootName = root.split(/[\\/]/).findLast((part) => part !== "") ?? root
  return (
    <ScrollView
      ref={scroller}
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={copy("mobile_files_crumbs_label")}
      onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: false })}
      style={[styles.crumbs, { borderColor: theme.border }]}
      contentContainerStyle={styles.crumbsContent}
    >
      {stack.map((path, depth) => {
        const current = depth === stack.length - 1
        const name = depth === 0 ? rootName : basename(path)
        return (
          <View key={path} style={styles.crumbItem}>
            {depth > 0 && <Icon name="RiArrowRightSLine" size={14} color={theme.textMuted} />}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={name}
              accessibilityState={{ disabled: current, selected: current }}
              disabled={current}
              onPress={() => onSelect(depth)}
              style={styles.crumb}
            >
              <Text
                numberOfLines={1}
                style={[styles.crumbLabel, { color: current ? theme.text : theme.textMuted }, current && styles.strong]}
              >
                {name}
              </Text>
            </Pressable>
          </View>
        )
      })}
    </ScrollView>
  )
}

function EntryRow({ entry, onPress }: { entry: FsEntry; onPress: () => void }) {
  const theme = useTheme()
  const folder = entry.kind === "dir"
  const nameColor = entry.ignored ? theme.textMuted : theme.text
  const label = [
    folder ? copy("mobile_files_folder_label", { name: entry.name }) : entry.name,
    entry.gitStatus !== null ? statusLabel(entry.gitStatus) : null,
    entry.ignored ? copy("mobile_files_ignored") : null,
  ]
    .filter((part) => part !== null)
    .join(", ")
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <Icon name={entryIcon(entry.path, entry.kind)} size={18} color={theme.textMuted} />
      <Text numberOfLines={1} style={[styles.rowName, { color: nameColor }]}>
        {entry.name}
      </Text>
      {entry.gitStatus !== null && (
        <Text style={[styles.statusLetter, { color: statusColor(theme)[entry.gitStatus] }]}>
          {statusLetter[entry.gitStatus]}
        </Text>
      )}
      {folder && <Icon name="RiArrowRightSLine" size={18} color={theme.textMuted} />}
    </Pressable>
  )
}

function PathSearch({
  threadId,
  query,
  files,
  onRetryFiles,
  searchContents,
  onSearchContents,
}: {
  threadId: string
  query: string
  files: Loaded<readonly string[]> | null
  onRetryFiles: () => void
  searchContents: boolean
  onSearchContents: () => void
}) {
  const theme = useTheme()
  const matches = files !== null && "value" in files ? matchPaths(files.value, query) : []
  return (
    <FlatList
      data={matches}
      keyExtractor={(match) => match.path}
      renderItem={({ item }) => <MatchRow match={item} onPress={() => openFile(threadId, item.path)} />}
      ListHeaderComponent={
        files === null ? (
          <Loading label={copy("mobile_files_loading")} />
        ) : "error" in files ? (
          <Failure message={files.error} onRetry={onRetryFiles} />
        ) : matches.length === 0 ? (
          <Text style={[styles.quiet, { color: theme.textMuted }]}>{copy("mobile_files_no_matches", { query })}</Text>
        ) : null
      }
      ListFooterComponent={
        searchContents ? (
          <ContentSearch threadId={threadId} query={query} />
        ) : (
          <Pressable
            testID="search-contents"
            accessibilityRole="button"
            accessibilityLabel={copy("mobile_files_search_contents", { query })}
            onPress={onSearchContents}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
          >
            <Icon name="RiSearchLine" size={18} color={theme.link} />
            <Text numberOfLines={1} style={[styles.rowName, { color: theme.link }]}>
              {copy("mobile_files_search_contents", { query })}
            </Text>
          </Pressable>
        )
      }
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    />
  )
}

function MatchRow({ match, onPress }: { match: PathMatch; onPress: () => void }) {
  const theme = useTheme()
  const folder = dirname(match.path)
  const nameStart = match.path.length - basename(match.path).length
  const hits = new Set(match.positions)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={match.path}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      <Icon name={entryIcon(match.path, "file")} size={18} color={theme.textMuted} />
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[styles.rowName, { color: theme.text }]}>
          <Emphasized text={match.path.slice(nameStart)} offset={nameStart} hits={hits} color={theme.link} />
        </Text>
        {folder !== "" && (
          <Text numberOfLines={1} ellipsizeMode="head" style={[styles.rowDetail, { color: theme.textMuted }]}>
            <Emphasized text={folder} offset={0} hits={hits} color={theme.text} />
          </Text>
        )}
      </View>
    </Pressable>
  )
}

/** `text` with the characters at `hits` (offset by `offset`) in `color` and bold. */
function Emphasized({
  text,
  offset,
  hits,
  color,
}: {
  text: string
  offset: number
  hits: ReadonlySet<number>
  color: string
}) {
  const runs: { text: string; hit: boolean; start: number }[] = []
  for (let index = 0; index < text.length; index++) {
    const hit = hits.has(index + offset)
    const last = runs[runs.length - 1]
    if (last !== undefined && last.hit === hit) last.text += text[index]
    else runs.push({ text: text[index], hit, start: index })
  }
  return runs.map((run) =>
    run.hit ? (
      <Text key={run.start} style={[styles.strong, { color }]}>
        {run.text}
      </Text>
    ) : (
      run.text
    ),
  )
}

function ContentSearch({ threadId, query }: { threadId: string; query: string }) {
  const theme = useTheme()
  const [result, setResult] = useState<(Loaded<readonly FileSearchHit[]> & { query: string }) | null>(null)
  const [revision, setRevision] = useState(0)

  // Once asked for, contents follow the query as it changes, 300 ms after the last keystroke, so typing does not
  // start a ripgrep run on the desktop per character.
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      call("search.files", { threadId, query, limit: 100 }).then(
        (hits) => current && setResult({ query, value: hits }),
        (cause) =>
          current &&
          setResult({ query, error: errorText(cause), tag: cause instanceof RpcError ? cause.tag : undefined }),
      )
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [threadId, query, revision])

  const shown = result?.query === query ? result : null
  return (
    <View>
      <Text style={[styles.heading, { color: theme.textMuted }]}>
        {copy("mobile_files_contents_heading", { query })}
      </Text>
      {shown === null ? (
        <Loading label={copy("mobile_files_searching")} />
      ) : "error" in shown ? (
        shown.tag === "RipgrepMissingError" ? (
          <View style={styles.padded}>
            <Notice text={copy("mobile_files_ripgrep_missing")} tone="attention" />
          </View>
        ) : (
          <Failure
            message={shown.error}
            onRetry={() => {
              setResult(null)
              setRevision(revision + 1)
            }}
          />
        )
      ) : shown.value.length === 0 ? (
        <Text style={[styles.quiet, { color: theme.textMuted }]}>{copy("mobile_files_no_lines", { query })}</Text>
      ) : (
        shown.value.map((hit) => (
          <HitRow
            key={`${hit.path}:${hit.line}`}
            hit={hit}
            query={query}
            onPress={() => openFile(threadId, hit.path, hit.line)}
          />
        ))
      )}
    </View>
  )
}

function HitRow({ hit, query, onPress }: { hit: FileSearchHit; query: string; onPress: () => void }) {
  const theme = useTheme()
  const location = `${hit.path}:${hit.line}`
  const at = hit.text.toLowerCase().indexOf(query.toLowerCase())
  const hits = new Set(at === -1 ? [] : Array.from({ length: query.length }, (_, index) => at + index))
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${location}, ${hit.text}`}
      onPress={onPress}
      style={({ pressed }) => [styles.hit, pressed && { backgroundColor: theme.surface }]}
    >
      <Text numberOfLines={1} ellipsizeMode="head" style={[styles.hitLocation, { color: theme.textMuted }]}>
        {location}
      </Text>
      <Text numberOfLines={2} style={[styles.hitText, { color: theme.text }]}>
        <Emphasized text={hit.text} offset={0} hits={hits} color={theme.attention} />
      </Text>
    </Pressable>
  )
}

/** A spinner and a label that appear only when loading takes a moment. */
export function Loading({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <Reveal style={styles.loading}>
      <Spinner color={theme.textMuted} />
      <Text accessibilityRole="progressbar" style={[styles.loadingLabel, { color: theme.textMuted }]}>
        {label}
      </Text>
    </Reveal>
  )
}

export function Failure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={[styles.padded, styles.failure]}>
      <Notice text={message} tone="danger" />
      <Button label={copy("mobile_files_retry")} icon="RiRefreshLine" onPress={onRetry} style={styles.retry} />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: "none" },
  strong: { fontWeight: "700" },
  search: { marginHorizontal: 12, marginBottom: 4 },
  crumbs: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  crumbsContent: { alignItems: "center", paddingHorizontal: 8 },
  crumbItem: { flexDirection: "row", alignItems: "center" },
  crumb: { minHeight: HIT, justifyContent: "center", paddingHorizontal: 6 },
  crumbLabel: { fontSize: 14, maxWidth: 220 },
  listContent: { paddingBottom: 24 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: HIT,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  rowName: { flex: 1, fontSize: 15 },
  rowDetail: { fontSize: 12, fontFamily: mono, marginTop: 2 },
  statusLetter: { fontFamily: mono, fontSize: 13, fontWeight: "700", width: 16, textAlign: "center" },
  heading: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
  hit: { minHeight: HIT, justifyContent: "center", gap: 2, paddingHorizontal: 16, paddingVertical: 8 },
  hitLocation: { fontFamily: mono, fontSize: 12 },
  hitText: { fontFamily: mono, fontSize: 13, lineHeight: 18 },
  quiet: { fontSize: 14, paddingHorizontal: 16, paddingVertical: 12 },
  padded: { paddingHorizontal: 12, paddingVertical: 8 },
  failure: { gap: 8 },
  retry: { alignSelf: "flex-start" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  loadingLabel: { fontSize: 14 },
})
