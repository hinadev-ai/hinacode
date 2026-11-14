import { useAtomMount } from "@effect/atom-react"
import { outputText, type Subagent, type SubagentStatus } from "@shared/agent.ts"
import type { Message, MessagePart, Thread } from "@shared/domain.ts"
import { inputField, statusOfCall, subagentReport } from "@shared/subagents.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, type ScrollViewInstance, StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { AssistantMessage } from "@/components/chat"
import { Button, EmptyState, Notice, Pill, ProviderLabel, type Tone } from "@/components/ui"
import { subagentStats, subagentStatusLabel, useSecondClock } from "@/components/subagents"
import { HIT, READABLE_WIDTH, radius } from "@/constants/theme"
import { useThreadConnection } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import {
  loadMissingSubagentsAtom,
  loadSubagentWorkAtom,
  type SubagentWork,
  useSubagentByCallId,
  useSubagentWork,
} from "@/stores/subagents"
import { useThreadRoot, useThreads } from "@/stores/threads"

type Params = { id: string; callId: string }

const PROMPT_LINES = 6
const PROMPT_CHARACTERS = 320
const STICK_TO_END = 48

const statusTone = {
  running: "running",
  completed: "neutral",
  failed: "danger",
  stopped: "neutral",
} satisfies Record<SubagentStatus, Tone>

export default function SubagentScreen() {
  const theme = useTheme()
  const { id, callId } = useLocalSearchParams<Params>()
  const thread = useThreads((state) => state.byId[id])
  const loaded = useThreads((state) => state.status === "ready")
  const connection = useThreadConnection(id)
  const subagent = useSubagentByCallId(id, callId)
  const work = useSubagentWork(id, callId)
  const progress = subagent && [subagent.status, subagent.toolUses, subagent.lastTool, subagent.summary].join("|")

  useAtomMount(loadSubagentWorkAtom(id, callId, progress))
  useAtomMount(loadMissingSubagentsAtom(id))

  return (
    <SafeAreaView edges={["bottom"]} style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: copy("mobile_subagent_title") }} />
      {connection !== "connected" && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {thread === undefined ? (
        loaded ? (
          <EmptyState icon="Question" title={copy("mobile_thread_missing")} />
        ) : (
          <Loading />
        )
      ) : work?.status === "error" ? (
        <View style={styles.centered}>
          <Notice text={work.message} tone="danger" />
        </View>
      ) : work?.status === "ready" ? (
        <SubagentBody thread={thread} callId={callId} subagent={subagent} work={work.work} />
      ) : (
        <Loading />
      )}
    </SafeAreaView>
  )
}

function Loading() {
  const theme = useTheme()
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={theme.textMuted} accessibilityLabel={copy("mobile_subagent_loading")} />
    </View>
  )
}

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const isToolCall = (part: MessagePart | null): part is ToolCall => part?.type === "tool_call"

function SubagentBody({
  thread,
  callId,
  subagent,
  work,
}: {
  thread: Thread
  callId: string
  subagent: Subagent | undefined
  work: SubagentWork
}) {
  const theme = useTheme()
  const root = useThreadRoot(thread)
  const scroller = useRef<ScrollViewInstance>(null)
  const [atEnd, setAtEnd] = useState(false)
  const spawn = isToolCall(work.spawn) ? work.spawn : undefined
  const calls = work.calls.filter(isToolCall)

  const status = subagent?.status ?? (spawn && statusOfCall[spawn.status])
  const label = subagent?.label ?? inputField(spawn, "description") ?? copy("mobile_subagent_untitled")
  const prompt = inputField(spawn, "prompt")
  const report =
    spawn?.output !== undefined
      ? subagentReport(outputText(spawn.output))
      : status !== "running"
        ? (subagent?.summary ?? undefined)
        : undefined
  const createdAt = work.startedAt ?? subagent?.startedAt

  if (status === undefined || createdAt === undefined)
    return <EmptyState icon="Question" title={copy("mobile_subagent_missing")} />

  const failed = status === "failed"
  const reply: Message = {
    id: `subagent:${callId}`,
    threadId: thread.id,
    role: "assistant",
    parts: report && !failed ? [...calls, { type: "text", text: report }] : calls,
    createdAt,
    completedAt: status === "running" ? null : createdAt,
    usage: null,
    forkPoint: null,
  }

  return (
    <ScrollView
      ref={scroller}
      testID="subagent-transcript"
      style={styles.flex}
      contentContainerStyle={styles.content}
      scrollEventThrottle={100}
      onScroll={({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) =>
        setAtEnd(contentOffset.y + layoutMeasurement.height >= contentSize.height - STICK_TO_END)
      }
      onContentSizeChange={() => {
        if (atEnd) scroller.current?.scrollToEnd({ animated: true })
      }}
    >
      <Text accessibilityRole="header" style={[styles.label, { color: theme.text }]}>
        {label}
      </Text>
      <View style={styles.meta}>
        <Pill label={subagentStatusLabel[status]} tone={statusTone[status]} />
        <ProviderLabel provider={subagent?.provider ?? thread.provider} size={12} />
      </View>
      {subagent !== undefined && <Stats subagent={subagent} />}
      {subagent?.status === "running" && <StopButton threadId={thread.id} subagent={subagent} />}
      {failed && <Notice text={report || copy("mobile_subagent_failed_unknown")} tone="danger" />}
      {prompt !== undefined && prompt !== "" && <Prompt text={prompt} />}
      {calls.length === 0 && reply.parts.length === 0 && status !== "running" ? (
        <Text style={[styles.empty, { color: theme.textMuted }]}>{copy("mobile_subagent_no_activity")}</Text>
      ) : (
        <AssistantMessage message={reply} root={root} foldsActivity={false} />
      )}
    </ScrollView>
  )
}

function Stats({ subagent }: { subagent: Subagent }) {
  const theme = useTheme()
  const now = useSecondClock(subagent.status === "running")
  return (
    <Text style={[styles.statsText, { color: theme.textMuted }]}>{subagentStats(subagent, now)}</Text>
  )
}

function StopButton({ threadId, subagent }: { threadId: string; subagent: Subagent }) {
  const theme = useTheme()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stop = async () => {
    setBusy(true)
    setError(null)
    try {
      await call("subagents.stop", { threadId, subagentId: subagent.id })
    } catch (cause) {
      setError(copy("mobile_subagent_stop_failed", { message: errorText(cause) }))
    }
    setBusy(false)
  }
  return (
    <View style={styles.stop}>
      <Button
        testID="subagent-stop"
        label={copy("mobile_subagent_stop")}
        accessibilityHint={copy("mobile_subagent_stop_hint")}
        icon="StopCircle"
        variant="danger"
        busy={busy}
        onPress={() => void stop()}
      />
      {error !== null && <Text style={{ color: theme.danger }}>{error}</Text>}
    </View>
  )
}

function Prompt({ text }: { text: string }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > PROMPT_CHARACTERS || text.split("\n").length > PROMPT_LINES
  return (
    <View
      accessibilityLabel={copy("mobile_subagent_prompt")}
      style={[styles.prompt, { backgroundColor: theme.surface }]}
    >
      <Text style={[styles.caption, { color: theme.textMuted }]}>{copy("mobile_subagent_prompt")}</Text>
      <Text
        selectable
        numberOfLines={expanded ? undefined : PROMPT_LINES}
        style={[styles.promptText, { color: theme.text }]}
      >
        {text}
      </Text>
      {long && (
        <Pressable
          accessibilityRole="button"
          aria-expanded={expanded}
          onPress={() => setExpanded(!expanded)}
          style={styles.more}
        >
          <Text style={[styles.moreText, { color: theme.link }]}>
            {copy(expanded ? "mobile_subagent_show_less" : "mobile_subagent_show_more")}
          </Text>
        </Pressable>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: { paddingHorizontal: 12, paddingTop: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { width: "100%", maxWidth: READABLE_WIDTH, alignSelf: "center", padding: 16, gap: 12 },
  label: { fontSize: 20, lineHeight: 26, fontWeight: "600" },
  meta: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  statsText: { fontSize: 13, fontVariant: ["tabular-nums"] },
  stop: { gap: 6, alignItems: "flex-start" },
  prompt: { borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  caption: { fontSize: 12, fontWeight: "600" },
  promptText: { fontSize: 15, lineHeight: 22 },
  more: { minHeight: HIT, justifyContent: "center", alignSelf: "flex-start" },
  moreText: { fontSize: 14, fontWeight: "600" },
  empty: { fontSize: 14 },
})
