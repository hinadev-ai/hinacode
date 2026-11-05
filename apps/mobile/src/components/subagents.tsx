import type { Subagent, SubagentStatus } from "@shared/agent.ts"
import type { MessagePart, Thread } from "@shared/domain.ts"
import { inFlight, inputField, statusOfCall } from "@shared/subagents.ts"
import { formatWorkDuration } from "@shared/workDuration.ts"
import { router } from "expo-router"
import { useEffect, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { FadeIn, Rotate } from "@/components/motion"
import { HIT, mono, type Palette, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy, locale } from "@/lib/copy"
import { useSubagentByCallId, useThreadSubagents } from "@/stores/subagents"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const ROW_HEIGHT = 56
const VISIBLE_ROWS = 4.5

export const subagentStatusLabel = {
  running: copy("mobile_subagent_status_running"),
  completed: copy("mobile_subagent_status_completed"),
  failed: copy("mobile_subagent_status_failed"),
  stopped: copy("mobile_subagent_status_stopped"),
} satisfies Record<SubagentStatus, string>

const statusIcon = {
  completed: "Check",
  failed: "Warning",
  stopped: "StopCircle",
} satisfies Record<Exclude<SubagentStatus, "running">, IconName>

const statusColor = (theme: Palette, status: SubagentStatus) =>
  status === "running" ? theme.token : status === "failed" ? theme.danger : theme.textMuted

export function SubagentStatusIcon({ status, size = 14 }: { status: SubagentStatus; size?: number }) {
  const theme = useTheme()
  const color = statusColor(theme, status)
  return (
    <View
      accessible
      accessibilityLabel={subagentStatusLabel[status]}
      style={[styles.statusIcon, { width: size, height: size }]}
    >
      {status === "running" ? (
        <View style={[styles.dot, { backgroundColor: color, width: size / 2, height: size / 2 }]} />
      ) : (
        <Icon name={statusIcon[status]} size={size} color={color} />
      )}
    </View>
  )
}

export function useSecondClock(ticking: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

const formatTokens = (tokens: number) => new Intl.NumberFormat(locale, { notation: "compact" }).format(tokens)

export const subagentStats = (subagent: Subagent, now: number) =>
  [
    subagent.toolUses === null ? null : copy("mobile_subagent_tools", { count: String(subagent.toolUses) }),
    subagent.tokens ? copy("mobile_subagent_tokens", { tokens: formatTokens(subagent.tokens) }) : null,
    formatWorkDuration(
      (subagent.endedAt === null ? now : Date.parse(subagent.endedAt)) - Date.parse(subagent.startedAt),
    ),
  ]
    .filter((stat) => stat !== null)
    .join(" · ")

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? ""

export const subagentDetail = (subagent: Subagent) =>
  subagent.summary
    ? firstLine(subagent.summary)
    : subagent.lastTool
      ? copy("mobile_subagent_last_tool", { tool: subagent.lastTool })
      : null

export const openSubagent = (threadId: string, callId: string) =>
  router.push({ pathname: "/thread/[id]/subagent", params: { id: threadId, callId } })

export function SubagentCall({ part, threadId }: { part: ToolCall; threadId: string }) {
  const theme = useTheme()
  const subagent = useSubagentByCallId(threadId, part.callId)
  const status = subagent?.status ?? statusOfCall[part.status]
  const label = subagent?.label ?? inputField(part, "description") ?? copy("mobile_subagent_untitled")
  return (
    <Pressable
      testID="subagent-call"
      accessibilityRole="button"
      accessibilityLabel={`${part.name} ${label}, ${subagentStatusLabel[status]}`}
      accessibilityHint={copy("mobile_subagent_open_hint")}
      onPress={() => openSubagent(threadId, part.callId)}
      style={({ pressed }) => [
        styles.call,
        { borderColor: theme.border, backgroundColor: pressed ? theme.surface : "transparent" },
      ]}
    >
      <SubagentStatusIcon status={status} />
      <Text numberOfLines={2} style={[styles.callText, { color: theme.text }]}>
        {part.name}
        <Text style={{ color: theme.textMuted }}> {label}</Text>
      </Text>
      <Icon name="ChevronRight" size={16} color={theme.textMuted} />
    </Pressable>
  )
}

function SubagentRow({ threadId, subagent, now }: { threadId: string; subagent: Subagent; now: number }) {
  const theme = useTheme()
  const detail = subagentDetail(subagent)
  const { callId } = subagent
  const body = (
    <>
      <View style={styles.rowIcon}>
        <SubagentStatusIcon status={subagent.status} />
      </View>
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowLabel, { color: theme.text }]}>
          {subagent.label}
        </Text>
        {detail !== null && (
          <Text numberOfLines={1} style={[styles.rowMeta, { color: theme.textMuted }]}>
            {detail}
          </Text>
        )}
        <Text style={[styles.rowMeta, styles.tabular, { color: theme.textMuted }]}>
          {subagentStats(subagent, now)}
        </Text>
      </View>
    </>
  )
  if (callId === null) return <View style={styles.row}>{body}</View>
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${subagent.label}, ${subagentStatusLabel[subagent.status]}`}
      accessibilityHint={copy("mobile_subagent_open_hint")}
      onPress={() => openSubagent(threadId, callId)}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.surface }]}
    >
      {body}
      <View style={styles.rowIcon}>
        <Icon name="ChevronRight" size={16} color={theme.textMuted} />
      </View>
    </Pressable>
  )
}

const segmentColor = (theme: Palette, status: SubagentStatus) =>
  status === "running"
    ? theme.token
    : status === "failed"
      ? theme.danger
      : status === "completed"
        ? theme.textMuted
        : theme.border

export function SubagentTray({ thread }: { thread: Thread }) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const subagents = inFlight(useThreadSubagents(thread.id))
  const now = useSecondClock(expanded && subagents.length > 0)
  if (subagents.length === 0) return null

  const running = subagents.filter((subagent) => subagent.status === "running")
  const failed = subagents.filter((subagent) => subagent.status === "failed").length
  const newest = running.at(-1)
  const progress = copy("mobile_subagent_batch", { running: String(running.length), total: String(subagents.length) })
  const failedText = failed > 0 ? copy("mobile_subagent_batch_failed", { count: String(failed) }) : null

  return (
    <View testID="subagent-tray" style={[styles.tray, { borderColor: theme.border, backgroundColor: theme.background }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[copy("mobile_subagent_list_label"), progress, failedText].filter(Boolean).join(", ")}
        aria-expanded={expanded}
        onPress={() => setExpanded(!expanded)}
        style={styles.header}
      >
        <View style={styles.meter}>
          {subagents.map((subagent) => (
            <View
              key={subagent.id}
              style={[styles.segment, { backgroundColor: segmentColor(theme, subagent.status) }]}
            />
          ))}
        </View>
        <Text style={[styles.progress, { color: theme.textMuted }]}>{progress}</Text>
        {failedText !== null && <Text style={[styles.progress, { color: theme.danger }]}>{failedText}</Text>}
        {!expanded && newest !== undefined && (
          <Text numberOfLines={1} style={[styles.newest, { color: theme.text }]}>
            {newest.label}
          </Text>
        )}
        <View style={styles.chevron}>
          <Rotate turned={expanded}>
            <Icon name="ChevronRight" size={16} color={theme.textMuted} />
          </Rotate>
        </View>
      </Pressable>
      {expanded && (
        <FadeIn>
          <ScrollView
            accessibilityLabel={copy("mobile_subagent_list_label")}
            style={{ maxHeight: ROW_HEIGHT * VISIBLE_ROWS }}
            contentContainerStyle={styles.list}
          >
            {[...subagents].reverse().map((subagent) => (
              <SubagentRow key={subagent.id} threadId={thread.id} subagent={subagent} now={now} />
            ))}
          </ScrollView>
        </FadeIn>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  statusIcon: { alignItems: "center", justifyContent: "center" },
  dot: { borderRadius: radius.full },
  call: {
    minHeight: HIT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  callText: { flex: 1, fontFamily: mono, fontSize: 13 },
  tray: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  header: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 8 },
  meter: { width: 40, height: 6, flexDirection: "row", gap: 1, borderRadius: radius.full, overflow: "hidden" },
  segment: { flex: 1 },
  progress: { fontSize: 13, fontVariant: ["tabular-nums"] },
  newest: { flex: 1, minWidth: 0, fontSize: 13 },
  chevron: { marginLeft: "auto" },
  list: { paddingHorizontal: 4, paddingBottom: 6 },
  row: {
    minHeight: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: radius.md,
  },
  rowIcon: { width: 16, alignItems: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  rowLabel: { fontSize: 14 },
  rowMeta: { fontSize: 12 },
  tabular: { fontVariant: ["tabular-nums"] },
})
