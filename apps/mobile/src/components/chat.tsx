import { useAtomMount } from "@effect/atom-react"
import type { Compaction } from "@shared/agent.ts"
import { collapsedParts } from "@shared/activityFold.ts"
import { formatWorkDuration } from "@shared/workDuration.ts"
import {
  type Message,
  type MessagePart,
  publishesArtifact,
  spawnsSubagent,
  type Thread,
} from "@shared/domain.ts"
import { isOwnPart } from "@shared/compactTranscript.ts"
import { useFocusEffect } from "expo-router"
import { useState } from "react"
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { ArtifactCard } from "@/components/artifact-card"
import { Composer } from "@/components/composer"
import { liquidGlass } from "@/components/glass"
import { Icon } from "@/components/icon"
import { Markdown } from "@/components/markdown"
import { FadeIn, Pulse, Rotate } from "@/components/motion"
import { ActivityTray } from "@/components/activity-tray"
import { SubagentCall } from "@/components/subagents"
import { FileChangeRow, ToolCallRow } from "@/components/tool-call"
import { Button, Notice } from "@/components/ui"
import { rise } from "@/constants/motion"
import { HIT, mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { motion } from "@/lib/motion"
import { ApprovalCard, QuestionCard, UsageLimitCallout } from "@/components/request-cards"
import { loadHistoryAtom, useMessages } from "@/stores/messages"
import { loadSubagentsAtom } from "@/stores/subagents"
import { useThreadRoot } from "@/stores/threads"

const CARD_PADDING = 12
const TRANSCRIPT_PADDING = 16

type CopyKey = Parameters<typeof copy>[0]

const risesInFlippedCell = { ...rise.initial, y: -rise.initial.y }

export function Chat({ thread, active }: { thread: Thread; active: boolean }) {
  const theme = useTheme()
  const history = useMessages((state) => state.byThread[thread.id])
  const root = useThreadRoot(thread)

  useFocusEffect(() => {
    if (active) return useMessages.getState().watch(thread.id)
  })
  useAtomMount(loadHistoryAtom(thread.id))
  useAtomMount(loadSubagentsAtom(thread.id))

  const messages = history?.status === "ready" ? history.messages : undefined
  const [openedNewest, setOpenedNewest] = useState<string | null>()
  if (messages !== undefined && openedNewest === undefined) setOpenedNewest(messages.at(-1)?.id ?? null)
  const openedAt = messages?.findIndex((message) => message.id === openedNewest) ?? -1
  const newestFirst = messages === undefined ? [] : [...messages].reverse()
  const arrivedAfterOpening = (newestFirstIndex: number) => newestFirst.length - 1 - newestFirstIndex > openedAt
  const [dockHeight, setDockHeight] = useState(0)
  const hasRequests =
    thread.usageLimit !== null ||
    (history?.status === "ready" && history.approvals.length + history.questions.length > 0)

  return (
    <View style={styles.flex}>
      {history?.status === "error" ? (
        <View style={styles.centered}>
          <Notice text={history.message} tone="danger" />
          <Button label={copy("mobile_chat_retry")} onPress={() => void useMessages.getState().load(thread.id)} />
        </View>
      ) : history?.status !== "ready" ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.textMuted} accessibilityLabel={copy("mobile_chat_loading")} />
        </View>
      ) : (
        <FlatList
          testID="transcript"
          accessibilityLabel={copy("mobile_chat_transcript")}
          style={styles.flex}
          inverted
          data={newestFirst}
          keyExtractor={(message) => message.id}
          renderItem={({ item, index }) => (
            <motion.View
              initial={arrivedAfterOpening(index) && risesInFlippedCell}
              animate={rise.animate}
            >
              <MessageView message={item} root={root} />
            </motion.View>
          )}
          initialNumToRender={4}
          maxToRenderPerBatch={2}
          windowSize={9}
          contentContainerStyle={[styles.transcript, liquidGlass && { paddingTop: dockHeight + 16 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReached={() => void useMessages.getState().loadEarlier(thread.id)}
          onEndReachedThreshold={1}
          ListFooterComponent={
            history.loadingEarlier ? (
              <ActivityIndicator
                style={styles.earlier}
                color={theme.textMuted}
                accessibilityLabel={copy("mobile_chat_loading")}
              />
            ) : undefined
          }
          ListEmptyComponent={
            <Text style={[styles.empty, { color: theme.textMuted }]}>{copy("mobile_chat_empty")}</Text>
          }
        />
      )}
      <View
        style={liquidGlass ? styles.dockStack : styles.dock}
        onLayout={liquidGlass ? (event) => setDockHeight(event.nativeEvent.layout.height) : undefined}
      >
        {hasRequests && (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            style={styles.requests}
            contentContainerStyle={styles.requestList}
          >
            {thread.usageLimit !== null && (
              <UsageLimitCallout key={thread.id} thread={thread} limit={thread.usageLimit} />
            )}
            {history?.status === "ready" &&
              history.approvals.map((request) => (
                <ApprovalCard key={request.id} request={request} since={thread.updatedAt} />
              ))}
            {history?.status === "ready" &&
              history.questions.map((request) => (
                <QuestionCard key={request.id} request={request} since={thread.updatedAt} />
              ))}
          </ScrollView>
        )}
        <ActivityTray thread={thread} messages={messages} />
        <Composer thread={thread} />
      </View>
    </View>
  )
}

function MessageView({ message, root }: { message: Message; root: string | null }) {
  const theme = useTheme()
  if (message.role !== "user") return <AssistantMessage message={message} root={root} />
  return (
    <View accessibilityLabel={copy("mobile_chat_you")} style={[styles.user, { backgroundColor: theme.surface }]}>
      {message.parts.map((part, index) => (
        <PartView key={index} part={part} threadId={message.threadId} />
      ))}
    </View>
  )
}

export function AssistantMessage({
  message,
  root,
  foldsActivity = true,
}: {
  message: Message
  root: string | null
  foldsActivity?: boolean
}) {
  const [activityShown, setActivityShown] = useState(false)
  const parts = message.parts.filter(isOwnPart)
  const { completedAt } = message
  const streaming = completedAt === null
  const durationMs = completedAt === null ? NaN : Date.parse(completedAt) - Date.parse(message.createdAt)
  const folded = foldsActivity && durationMs >= 0
  if (!streaming && parts.length === 0) return null
  const writingIndex = streaming && parts.at(-1)?.type === "text" ? parts.length - 1 : undefined
  const collapsed = new Set(collapsedParts(parts.map((part, index) => ({ part, index }))).map(({ index }) => index))
  return (
    <View aria-busy={streaming} style={styles.reply}>
      {folded && (
        <WorkedFor
          durationMs={durationMs}
          expanded={activityShown}
          onToggle={collapsed.size < parts.length ? () => setActivityShown(!activityShown) : undefined}
        />
      )}
      {parts.map((part, index) => {
        const view =
          part.type === "text" ? (
            <ReplyText
              key={index}
              text={part.text}
              done={index !== writingIndex}
              root={root}
              threadId={message.threadId}
            />
          ) : (
            <PartView key={index} part={part} threadId={message.threadId} />
          )
        if (!folded || collapsed.has(index)) return view
        return activityShown ? <FadeIn key={index}>{view}</FadeIn> : null
      })}
      {streaming && (parts.length === 0 || writingIndex !== undefined) && (
        <Pulse
          text={copy(writingIndex !== undefined ? "mobile_chat_writing" : "mobile_chat_thinking")}
          style={styles.pulse}
        />
      )}
    </View>
  )
}

function ReplyText({
  text,
  done,
  root,
  threadId,
}: {
  text: string
  done: boolean
  root: string | null
  threadId: string
}) {
  const [finishedOnScreen] = useState(!done)
  if (!done) return null
  return (
    <FadeIn enabled={finishedOnScreen}>
      <Markdown text={text} root={root} threadId={threadId} gutter={TRANSCRIPT_PADDING} />
    </FadeIn>
  )
}

function WorkedFor({
  durationMs,
  expanded,
  onToggle,
}: {
  durationMs: number
  expanded: boolean
  onToggle: (() => void) | undefined
}) {
  const theme = useTheme()
  if (onToggle === undefined && durationMs < 1000) return null
  const label = copy("mobile_chat_worked_for", { duration: formatWorkDuration(durationMs) })
  const row = styles.workedFor
  const text = (
    <>
      <Icon name="Clock" size={14} color={theme.textMuted} />
      <Text numberOfLines={1} style={[styles.workedForText, { color: theme.textMuted }]}>
        {label}
      </Text>
    </>
  )
  if (onToggle === undefined) return <View style={row}>{text}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={copy(expanded ? "mobile_chat_hide_activity" : "mobile_chat_show_activity")}
      aria-expanded={expanded}
      hitSlop={WORKED_FOR_SLOP}
      onPress={onToggle}
      style={row}
    >
      {text}
      <Rotate turned={expanded}>
        <Icon name="ChevronRight" size={14} color={theme.textMuted} />
      </Rotate>
    </Pressable>
  )
}

function PartView({ part, threadId }: { part: MessagePart; threadId: string }) {
  const theme = useTheme()
  switch (part.type) {
    case "text":
      return (
        <Text selectable style={[styles.text, { color: theme.text }]}>
          {part.text}
        </Text>
      )
    case "reasoning":
      return <Reasoning text={part.text} />
    case "tool_call": {
      if (spawnsSubagent(part)) return <SubagentCall part={part} threadId={threadId} />
      if (publishesArtifact(part)) return <ArtifactCard part={part} threadId={threadId} />
      return <ToolCallRow call={part} threadId={threadId} />
    }
    case "file_change":
      return <FileChangeRow path={part.path} />
    case "attachment":
      return (
        <Text style={{ color: theme.textMuted }}>{copy("mobile_chat_attached", { name: part.attachment.name })}</Text>
      )
    case "questions":
      return <Text style={[styles.text, { color: theme.text }]}>{part.text}</Text>
    case "compaction":
      return (
        <Text style={{ color: part.compaction.status === "failed" ? theme.danger : theme.textMuted }}>
          {copy(compactionCopy[part.compaction.status])}
        </Text>
      )
    case "agent_switch":
      return (
        <Text style={{ color: theme.textMuted }}>
          {copy("mobile_chat_agent_switched", {
            from: copy(`mobile_provider_${part.from}`),
            to: copy(`mobile_provider_${part.to}`),
          })}
        </Text>
      )
    case "session_import":
      return (
        <Text style={{ color: theme.textMuted }}>
          {copy(part.history === "replayed" ? "mobile_chat_session_imported" : "mobile_chat_session_imported_unavailable", {
            agent: copy(`mobile_provider_${part.provider}`),
          })}
        </Text>
      )
    case "signed_out":
      return (
        <View style={[styles.card, { borderColor: theme.attention, backgroundColor: theme.attentionBg }]}>
          <Text selectable style={[styles.cardBody, { color: theme.text }]}>
            {part.message}
          </Text>
          <Text style={[styles.cardNote, { color: theme.textMuted }]}>
            {copy(part.loginCommand === undefined ? "mobile_chat_signed_out_docs_hint" : "mobile_chat_signed_out_hint")}
          </Text>
          {part.loginCommand !== undefined && (
            <Text selectable style={[styles.detail, { color: theme.text, backgroundColor: theme.surface }]}>
              {part.loginCommand}
            </Text>
          )}
        </View>
      )
  }
}

const compactionCopy = {
  running: "mobile_chat_compacting",
  done: "mobile_chat_compacted",
  failed: "mobile_chat_compaction_failed",
} as const satisfies Record<Compaction["status"], CopyKey>

function Reasoning({ text }: { text: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        aria-expanded={open}
        accessibilityLabel={copy("mobile_chat_reasoning")}
        hitSlop={WORKED_FOR_SLOP}
        onPress={() => setOpen(!open)}
        style={styles.disclosure}
      >
        <Rotate turned={open}>
          <Icon name="ChevronRight" size={14} color={theme.textMuted} />
        </Rotate>
        <Text style={{ color: theme.textMuted, fontSize: 13 }}>
          {copy(open ? "mobile_chat_hide_reasoning" : "mobile_chat_reasoning")}
        </Text>
      </Pressable>
      {open && (
        <FadeIn>
          <Text selectable style={[styles.reasoning, { color: theme.textMuted }]}>
            {text}
          </Text>
        </FadeIn>
      )}
    </View>
  )
}

const WORKED_FOR_HEIGHT = 28
const WORKED_FOR_SLOP = { top: (HIT - WORKED_FOR_HEIGHT) / 2, bottom: (HIT - WORKED_FOR_HEIGHT) / 2 }

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 20, gap: 12 },
  transcript: { padding: TRANSCRIPT_PADDING, gap: 12 },
  dock: { flexShrink: 1 },
  dockStack: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "100%" },
  requests: { flexGrow: 0, flexShrink: 1 },
  requestList: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  earlier: { paddingVertical: 12 },
  empty: { textAlign: "center", padding: 24, fontSize: 15 },
  user: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    gap: 6,
    borderRadius: radius.xl,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  reply: { gap: 6 },
  text: { fontSize: 15, lineHeight: 22 },
  pulse: { fontSize: 12 },
  workedFor: {
    minHeight: WORKED_FOR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  workedForText: { flexShrink: 1, fontSize: 13, fontVariant: ["tabular-nums"] },
  disclosure: { minHeight: WORKED_FOR_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8 },
  reasoning: { fontSize: 13, lineHeight: 19 },
  card: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: radius.sm + CARD_PADDING,
    padding: CARD_PADDING,
    gap: 10,
  },
  cardBody: { fontSize: 15, lineHeight: 21 },
  cardNote: { fontSize: 13, lineHeight: 18 },
  detail: { fontFamily: mono, fontSize: 12, padding: 8, borderRadius: radius.sm },
})
