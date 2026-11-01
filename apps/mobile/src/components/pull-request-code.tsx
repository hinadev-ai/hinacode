import type {
  GuideCategory,
  GuideFileNote,
  GuideLineNote,
  PullRequestDetail,
  PullRequestFile,
  PullRequestFileStatus,
  PullRequestGuideState,
} from "@shared/domain.ts"
import {
  diffTooLarge,
  type GuideFile,
  groupFiles,
  type ResolvedGroup,
  resolveGuide,
} from "@shared/pullRequestGuide.ts"
import { useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { PressableScale, Reveal, Rotate, Spinner } from "@/components/motion"
import { Button, Notice, SegmentedControl } from "@/components/ui"
import { HIT, mono, type Palette, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { type PatchLine, patchLines } from "@/lib/patch-lines"
import { type CodeView, filesKey, usePullRequests } from "@/stores/pull-requests"

/** Lines a diff shows before it asks, so opening a generated file does not stall the screen. */
const FIRST_LINES = 300

const categoryIcon: Record<GuideCategory, IconName> = {
  ui: "RiLayoutMasonryLine",
  api: "RiPlugLine",
  core: "RiCodeSSlashLine",
  data: "RiDatabase2Line",
  cli: "RiTerminalBoxLine",
  security: "RiShieldKeyholeLine",
  tests: "RiFlaskLine",
  docs: "RiBookOpenLine",
  examples: "RiPlayCircleLine",
  deps: "RiBox3Line",
  build: "RiHammerLine",
  scripts: "RiToolsLine",
  config: "RiEqualizerLine",
  i18n: "RiTranslate2",
  assets: "RiImageLine",
  other: "RiMoreLine",
}

const fileMark = (theme: Palette): Record<PullRequestFileStatus, { letter: string; color: string }> => ({
  added: { letter: "A", color: theme.running },
  removed: { letter: "D", color: theme.danger },
  modified: { letter: "M", color: theme.attention },
  // As on the desktop: violet is kept for focus and the primary action.
  renamed: { letter: "R", color: theme.attention },
  copied: { letter: "C", color: theme.running },
})

const shortCommit = (head: string) => head.slice(0, 7)

const noteKey = (note: GuideFileNote | GuideLineNote) =>
  "line" in note ? `${note.side}:${note.line}:${note.text}` : note.text

const viewSegments = [
  { value: "files", label: copy("mobile_pr_code_files"), icon: "RiFileTextLine" },
  { value: "guide", label: copy("mobile_pr_code_guide"), icon: "RiGuideLine" },
] as const

/** The Code tab: the pull request's changed files, listed by path or in the order its guide reads them. */
export function PullRequestCode({ detail }: { detail: PullRequestDetail }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const view = usePullRequests((state) => state.codeView)
  const remote = usePullRequests((state) => state.files[filesKey(detail.url, detail.head)])
  const tooLarge = diffTooLarge(detail)

  useEffect(() => {
    if (connected && !tooLarge) void usePullRequests.getState().loadFiles(detail.url, detail.head)
  }, [connected, tooLarge, detail.url, detail.head])

  return (
    <View style={styles.code}>
      <SegmentedControl<CodeView>
        segments={viewSegments}
        value={view}
        onChange={(next) => usePullRequests.getState().setCodeView(next)}
        accessibilityLabel={copy("mobile_pr_code_view_label")}
      />
      {tooLarge ? (
        <Text style={[styles.muted, { color: theme.textMuted }]}>
          {copy("mobile_pr_code_too_large")}
        </Text>
      ) : remote === undefined || remote.status === "loading" ? (
        <Loading label={copy("mobile_pr_code_loading")} />
      ) : remote.status === "error" ? (
        <View style={styles.stack}>
          <Notice tone="danger" text={copy("mobile_pr_code_failed", { message: remote.message })} />
          <Button
            label={copy("mobile_pr_retry")}
            icon="RiRefreshLine"
            style={styles.start}
            onPress={() => void usePullRequests.getState().loadFiles(detail.url, detail.head, { force: true })}
          />
        </View>
      ) : remote.value.length === 0 ? (
        <Text style={[styles.muted, { color: theme.textMuted }]}>{copy("mobile_pr_code_empty")}</Text>
      ) : (
        <>
          <DiffSummary files={remote.value} />
          {view === "files" ? (
            <View>
              {remote.value.map((file) => (
                <FileRow
                  key={file.path}
                  entry={{ file, fileNotes: [], lineNotesInHunks: [], lineNotesOutsideHunks: [] }}
                />
              ))}
            </View>
          ) : (
            <GuideView detail={detail} files={remote.value} />
          )}
        </>
      )}
    </View>
  )
}

function Loading({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <Reveal style={styles.loading}>
      <Spinner color={theme.textMuted} />
      <Text style={{ color: theme.textMuted }}>{label}</Text>
    </Reveal>
  )
}

function LineCounts({ added, removed }: { added: number; removed: number }) {
  const theme = useTheme()
  return (
    <Text
      accessibilityLabel={copy("mobile_pr_size", { additions: String(added), deletions: String(removed) })}
      style={styles.counts}
    >
      <Text style={{ color: theme.running }}>+{added}</Text> <Text style={{ color: theme.danger }}>−{removed}</Text>
    </Text>
  )
}

const sum = (files: readonly PullRequestFile[], key: "additions" | "deletions") =>
  files.reduce((total, file) => total + file[key], 0)

function DiffSummary({ files }: { files: readonly PullRequestFile[] }) {
  const theme = useTheme()
  return (
    <View style={styles.summary}>
      <Text style={[styles.muted, { color: theme.textMuted }]}>
        {copy("mobile_pr_code_summary", { count: String(files.length) })}
      </Text>
      <LineCounts added={sum(files, "additions")} removed={sum(files, "deletions")} />
    </View>
  )
}

const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? { folder: "", name: path } : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) }
}

function FileRow({ entry }: { entry: GuideFile }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const { file } = entry
  const notes = [...entry.fileNotes, ...entry.lineNotesOutsideHunks]
  const critical = [...notes, ...entry.lineNotesInHunks].some((note) => note.critical === true)
  const mark = fileMark(theme)[file.status]
  const { folder, name } = splitPath(file.path)
  const status = copy(`mobile_pr_file_${file.status}`)

  return (
    <View style={[styles.file, { borderColor: theme.border }]}>
      <PressableScale
        testID="pull-request-file"
        accessibilityRole="button"
        accessibilityLabel={[file.path, status, critical && copy("mobile_pr_guide_critical")]
          .filter((part) => typeof part === "string")
          .join(", ")}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.fileHeader}
      >
        <Rotate turned={open}>
          <Icon name="RiArrowRightSLine" size={16} color={theme.textMuted} />
        </Rotate>
        <Text style={[styles.mark, { color: mark.color }]}>{mark.letter}</Text>
        <View style={styles.fileName}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.path, { color: theme.text }]}>
            {name}
          </Text>
          {folder !== "" && (
            // The end of a folder tells files apart better than its start.
            <Text numberOfLines={1} ellipsizeMode="head" style={[styles.renamed, { color: theme.textMuted }]}>
              {folder}
            </Text>
          )}
          {file.previousPath !== null && (
            <Text numberOfLines={1} style={[styles.renamed, { color: theme.textMuted }]}>
              {copy("mobile_pr_file_from", { path: file.previousPath })}
            </Text>
          )}
        </View>
        {critical && <Icon name="RiErrorWarningLine" size={16} color={theme.attention} />}
        <LineCounts added={file.additions} removed={file.deletions} />
      </PressableScale>
      {notes.length > 0 && (
        <View style={styles.notes}>
          {notes.map((note) => (
            <NoteCard key={noteKey(note)} note={note} showLine />
          ))}
        </View>
      )}
      {open && (
        <Reveal>
          {file.binary ? (
            <Text style={[styles.muted, styles.patchNote, { color: theme.textMuted }]}>
              {copy("mobile_pr_file_binary")}
            </Text>
          ) : (
            <Patch patch={file.patch} notes={entry.lineNotesInHunks} />
          )}
        </Reveal>
      )}
    </View>
  )
}

const notesOn = (notes: readonly GuideLineNote[], line: PatchLine) =>
  notes.filter((note) => (note.side === "additions" ? line.newLine : line.oldLine) === note.line)

/** A unified diff whose long lines wrap, since a phone has no width for a split one or for scrolling sideways. */
function Patch({ patch, notes }: { patch: string; notes: readonly GuideLineNote[] }) {
  const theme = useTheme()
  const [showAll, setShowAll] = useState(false)
  const lines = patchLines(patch)
  if (lines.length === 0) {
    return (
      <Text style={[styles.muted, styles.patchNote, { color: theme.textMuted }]}>
        {copy("mobile_pr_file_no_lines")}
      </Text>
    )
  }
  const shown = showAll ? lines : lines.slice(0, FIRST_LINES)
  const tint: Record<PatchLine["kind"], string | undefined> = {
    addition: theme.runningBg,
    deletion: theme.dangerBg,
    hunk: theme.surface,
    note: undefined,
    context: undefined,
  }
  const sign: Record<PatchLine["kind"], { text: string; color: string }> = {
    addition: { text: "+", color: theme.running },
    deletion: { text: "−", color: theme.danger },
    hunk: { text: "", color: theme.textMuted },
    note: { text: "", color: theme.textMuted },
    context: { text: "", color: theme.textMuted },
  }
  return (
    <View style={[styles.patch, { borderColor: theme.border }]}>
      {shown.map((line, index) => {
        const code = line.kind !== "hunk" && line.kind !== "note"
        const onLine = notesOn(notes, line)
        return (
          <View key={index}>
            <View style={[styles.line, { backgroundColor: tint[line.kind] }]}>
              <Text style={[styles.gutter, { color: theme.textMuted }]}>{line.newLine ?? line.oldLine ?? ""}</Text>
              {/* Its own column, so a wrapped line hangs under its code instead of under the sign. */}
              <Text style={[styles.sign, { color: sign[line.kind].color }]}>{sign[line.kind].text}</Text>
              <Text selectable style={[styles.lineText, { color: code ? theme.text : theme.textMuted }]}>
                {code ? line.text.replace(/\t/g, "  ") : line.text}
              </Text>
            </View>
            {onLine.length > 0 && (
              <View style={styles.lineNotes}>
                {onLine.map((note) => (
                  <NoteCard key={noteKey(note)} note={note} />
                ))}
              </View>
            )}
          </View>
        )
      })}
      {!showAll && lines.length > FIRST_LINES && (
        <Button
          label={copy("mobile_pr_file_more", { count: String(lines.length - FIRST_LINES) })}
          variant="ghost"
          onPress={() => setShowAll(true)}
        />
      )}
    </View>
  )
}

function NoteCard({ note, showLine = false }: { note: GuideFileNote | GuideLineNote; showLine?: boolean }) {
  const theme = useTheme()
  const critical = note.critical === true
  return (
    <View
      accessibilityLabel={critical ? copy("mobile_pr_guide_critical") : undefined}
      style={[
        styles.noteCard,
        critical
          ? { backgroundColor: theme.attentionBg, borderColor: theme.attentionBg }
          : { backgroundColor: theme.surface, borderColor: theme.border },
      ]}
    >
      <Icon
        name={critical ? "RiErrorWarningLine" : "RiGuideLine"}
        size={14}
        color={critical ? theme.attention : theme.textMuted}
      />
      <View style={styles.noteBody}>
        {showLine && "line" in note && (
          <Text style={[styles.noteLine, { color: theme.textMuted }]}>
            {copy("mobile_pr_guide_line", { line: String(note.line) })}
          </Text>
        )}
        <Markdown text={note.text} root={null} />
      </View>
    </View>
  )
}

function GuideView({ detail, files }: { detail: PullRequestDetail; files: readonly PullRequestFile[] }) {
  const theme = useTheme()
  const connected = useConnection((state) => state.status === "connected")
  const remote = usePullRequests((state) => state.guides[detail.url])

  useEffect(() => {
    if (connected) void usePullRequests.getState().loadGuide(detail.url)
  }, [connected, detail.url])

  if (remote === undefined || remote.status === "loading") return <Loading label={copy("mobile_pr_guide_loading")} />
  if (remote.status === "error") {
    return (
      <View style={styles.stack}>
        <Notice tone="danger" text={remote.message} />
        <Button
          label={copy("mobile_pr_retry")}
          icon="RiRefreshLine"
          style={styles.start}
          onPress={() => void usePullRequests.getState().loadGuide(detail.url, { force: true })}
        />
      </View>
    )
  }
  const state = remote.value
  const { guide } = state
  if (guide === null) return <GuideJob detail={detail} state={state} />
  const { groups, others } = resolveGuide(guide, files)
  const other: ResolvedGroup = {
    key: "other",
    label: copy("mobile_pr_guide_other"),
    summary: copy("mobile_pr_guide_other_hint"),
    category: "other",
    containsCritical: false,
    files: others,
    children: [],
  }

  return (
    <View style={styles.guide}>
      {guide.head !== detail.head && <GuideJob detail={detail} state={state} />}
      <Markdown text={guide.summary} root={null} />
      {[...groups, ...(others.length > 0 ? [other] : [])].map((group) => (
        <View key={group.key} style={[styles.group, { borderTopColor: theme.border }]}>
          <GuideGroup group={group} />
        </View>
      ))}
      <Text style={[styles.small, { color: theme.textMuted }]}>
        {copy("mobile_pr_guide_written_by", { model: guide.model, commit: shortCommit(guide.head) })}
      </Text>
    </View>
  )
}

function GuideGroup({ group }: { group: ResolvedGroup }) {
  const theme = useTheme()
  const files = groupFiles(group)
  const category = copy(`mobile_pr_guide_category_${group.category}`)
  return (
    <View style={styles.stack}>
      <View style={styles.groupHeader}>
        <View accessible accessibilityLabel={category} style={styles.groupIcon}>
          <Icon name={categoryIcon[group.category]} size={16} color={theme.textMuted} />
        </View>
        <Text accessibilityRole="header" style={[styles.groupLabel, { color: theme.text }]}>
          {group.label}
        </Text>
        {group.containsCritical && (
          <View accessible accessibilityLabel={copy("mobile_pr_guide_critical")}>
            <Icon name="RiErrorWarningLine" size={16} color={theme.attention} />
          </View>
        )}
      </View>
      <View style={[styles.summary, styles.indent]}>
        <Text style={[styles.small, { color: theme.textMuted }]}>
          {copy("mobile_pr_guide_group_files", { count: String(files.length) })}
        </Text>
        <LineCounts
          added={sum(
            files.map((entry) => entry.file),
            "additions",
          )}
          removed={sum(
            files.map((entry) => entry.file),
            "deletions",
          )}
        />
      </View>
      {group.summary !== undefined && (
        <View style={styles.indent}>
          <Markdown text={group.summary} root={null} />
        </View>
      )}
      {group.files.length > 0 && (
        <View>
          {group.files.map((entry) => (
            <FileRow key={entry.file.path} entry={entry} />
          ))}
        </View>
      )}
      {group.children.length > 0 && (
        <View style={[styles.children, { borderLeftColor: theme.border }]}>
          {group.children.map((child) => (
            <GuideGroup key={child.key} group={child} />
          ))}
        </View>
      )}
    </View>
  )
}

/** Where the guide for the latest commit stands: being written, failed, or not started. */
function GuideJob({ detail, state }: { detail: PullRequestDetail; state: PullRequestGuideState }) {
  const theme = useTheme()
  const job = state.job?.head === detail.head ? state.job : null
  const outdated = state.guide !== null && state.guide.head !== detail.head ? state.guide : null

  if (job?.status === "failed") {
    return (
      <View style={styles.stack}>
        {outdated !== null && (
          <Notice tone="attention" text={copy("mobile_pr_guide_outdated", { commit: shortCommit(outdated.head) })} />
        )}
        <Notice tone="danger" text={copy("mobile_pr_guide_failed", { message: job.message })} />
        <RetryGuide url={detail.url} />
      </View>
    )
  }
  if (outdated !== null) {
    return (
      <Notice
        tone="attention"
        text={[
          copy("mobile_pr_guide_outdated", { commit: shortCommit(outdated.head) }),
          job?.status === "running" ? copy("mobile_pr_guide_outdated_writing") : null,
        ]
          .filter((part) => part !== null)
          .join(" ")}
      />
    )
  }
  if (job?.status === "running") {
    return (
      <View style={styles.stack}>
        <View style={styles.summary}>
          <Spinner size={14} color={theme.textMuted} />
          <Text style={[styles.muted, { color: theme.text }]}>
            {copy("mobile_pr_guide_writing", { commit: shortCommit(detail.head) })}
          </Text>
        </View>
        <Text style={[styles.small, { color: theme.textMuted }]}>{copy("mobile_pr_guide_writing_hint")}</Text>
      </View>
    )
  }
  const closed = detail.status === "merged" || detail.status === "closed"
  return (
    <Text style={[styles.muted, { color: theme.textMuted }]}>
      {copy(closed ? "mobile_pr_guide_closed" : "mobile_pr_guide_not_started")}
    </Text>
  )
}

/** Asks the desktop to write the guide again. The new state arrives as a push. */
function RetryGuide({ url }: { url: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retry = async () => {
    setBusy(true)
    setError(null)
    try {
      await call("pullRequestGuides.retry", { url })
    } catch (cause) {
      setError(errorText(cause))
    }
    setBusy(false)
  }
  return (
    <View style={styles.stack}>
      <Button
        label={copy("mobile_pr_retry")}
        icon="RiRefreshLine"
        busy={busy}
        style={styles.start}
        onPress={() => void retry()}
      />
      {error !== null && <Notice tone="danger" text={error} />}
    </View>
  )
}

const styles = StyleSheet.create({
  code: { gap: 12 },
  stack: { gap: 8 },
  start: { alignSelf: "flex-start" },
  loading: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 24 },
  muted: { fontSize: 14, lineHeight: 20 },
  small: { fontSize: 13, lineHeight: 18 },
  summary: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  counts: { flexShrink: 0, fontFamily: mono, fontSize: 12 },
  file: { borderBottomWidth: StyleSheet.hairlineWidth },
  fileHeader: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  mark: { width: 12, fontFamily: mono, fontSize: 12, fontWeight: "700", textAlign: "center" },
  fileName: { flex: 1, gap: 2 },
  path: { fontFamily: mono, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  renamed: { fontFamily: mono, fontSize: 12 },
  notes: { gap: 6, paddingLeft: 24, paddingBottom: 8 },
  patch: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, overflow: "hidden", marginBottom: 10 },
  patchNote: { paddingBottom: 10, paddingLeft: 24 },
  line: { flexDirection: "row", paddingRight: 8 },
  gutter: {
    width: 40,
    flexShrink: 0,
    paddingRight: 6,
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 18,
    textAlign: "right",
  },
  sign: { width: 14, flexShrink: 0, fontFamily: mono, fontSize: 12, lineHeight: 18, textAlign: "center" },
  // A browser keeps a flex item as wide as its longest token unless it may shrink, so a long one ran off screen.
  lineText: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: 12, lineHeight: 18 },
  lineNotes: { gap: 6, padding: 8 },
  noteCard: {
    flexDirection: "row",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  noteBody: { flex: 1, gap: 2 },
  noteLine: { fontFamily: mono, fontSize: 12 },
  guide: { gap: 16 },
  group: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16 },
  groupHeader: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  groupIcon: { paddingTop: 2 },
  groupLabel: { flex: 1, fontSize: 15, fontWeight: "600", lineHeight: 20 },
  indent: { paddingLeft: 24 },
  children: { marginLeft: 8, paddingLeft: 12, borderLeftWidth: StyleSheet.hairlineWidth, gap: 16 },
})
