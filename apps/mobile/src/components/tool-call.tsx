import type { MessagePart, ToolCallStatus } from "@shared/domain.ts"
import { useEffect, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { FadeIn, Rotate, Spinner } from "@/components/motion"
import { Button } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { describeToolCall, toolIcon } from "@/lib/tool-call"
import { toolOutputKey, useToolOutputs } from "@/stores/tool-outputs"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const ROW_HEIGHT = 32
const ROW_SLOP = { top: 6, bottom: 6 }
const ICON_SIZE = 16

const statusLabel = {
  running: "mobile_chat_tool_running",
  error: "mobile_chat_tool_failed",
  done: "mobile_chat_tool_done",
} as const

/** One receding line per tool call, like the desktop's tool row. Opening it shows the call and loads its output. */
export function ToolCallRow({ call, threadId }: { call: ToolCall; threadId: string }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const { name, summary } = describeToolCall(call)
  const command = call.name === "Bash" && summary !== ""
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[name, summary, copy(statusLabel[call.status])].filter((text) => text !== "").join(", ")}
        aria-expanded={open}
        hitSlop={ROW_SLOP}
        onPress={() => setOpen(!open)}
        style={styles.row}
      >
        <Icon name={toolIcon(call.name)} size={ICON_SIZE} color={theme.textMuted} />
        <Text numberOfLines={1} style={[styles.label, { color: theme.textMuted }]}>
          {command ? (
            <Text style={styles.mono}>{summary}</Text>
          ) : (
            <>
              {name}
              {summary !== "" && <Text style={styles.mono}> {summary}</Text>}
            </>
          )}
        </Text>
        <StatusIcon status={call.status} />
        <Rotate turned={open}>
          <Icon name="ChevronRight" size={14} color={theme.textMuted} />
        </Rotate>
      </Pressable>
      {open && (
        <FadeIn style={styles.details}>
          {command ? (
            <View style={[styles.block, { backgroundColor: theme.surface }]}>
              <Text selectable style={[styles.code, { color: theme.text }]}>
                {summary}
              </Text>
              {call.status !== "running" && (
                <View style={styles.commandOutput}>
                  <ToolOutput call={call} threadId={threadId} />
                </View>
              )}
            </View>
          ) : (
            <>
              <InputSection input={call.input} />
              <Text style={[styles.heading, { color: theme.textMuted }]}>{copy("mobile_chat_tool_output")}</Text>
              <View style={[styles.block, { backgroundColor: theme.surface }]}>
                {call.status === "running" ? (
                  <Spinner size={14} color={theme.textMuted} />
                ) : (
                  <ToolOutput call={call} threadId={threadId} />
                )}
              </View>
            </>
          )}
        </FadeIn>
      )}
    </View>
  )
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
  const theme = useTheme()
  if (status === "running") return <Spinner size={14} color={theme.textMuted} />
  if (status === "error") return <Icon name="Warning" size={14} color={theme.danger} />
  return null
}

function InputSection({ input }: { input: unknown }) {
  const theme = useTheme()
  const text = JSON.stringify(input, null, 2)
  if (text === undefined || text === "{}") return null
  return (
    <>
      <Text style={[styles.heading, { color: theme.textMuted }]}>{copy("mobile_chat_tool_input")}</Text>
      <Text selectable style={[styles.code, styles.block, { color: theme.text, backgroundColor: theme.surface }]}>
        {text}
      </Text>
    </>
  )
}

function ToolOutput({ call, threadId }: { call: ToolCall; threadId: string }) {
  const theme = useTheme()
  const output = useToolOutputs((state) => state.byCall[toolOutputKey(threadId, call.callId)])
  const load = () => void useToolOutputs.getState().load(threadId, call.callId)
  useEffect(() => {
    if (output === undefined) void useToolOutputs.getState().load(threadId, call.callId)
  }, [output, threadId, call.callId])

  if (output === undefined || output.status === "loading")
    return (
      <View accessible accessibilityLabel={copy("mobile_chat_tool_loading_output")}>
        <Spinner size={14} color={theme.textMuted} />
      </View>
    )
  if (output.status === "error")
    return (
      <View style={styles.failed}>
        <Text style={[styles.note, styles.failedText, { color: theme.danger }]}>
          {copy("mobile_chat_tool_output_failed", { message: output.message })}
        </Text>
        <Button label={copy("mobile_chat_retry")} variant="ghost" onPress={load} />
      </View>
    )
  if (output.text === "")
    return (
      <Text style={[styles.note, { color: theme.textMuted }]}>{copy("mobile_chat_tool_no_output")}</Text>
    )
  return (
    <View style={styles.shown}>
      {output.truncated && (
        <Text style={[styles.note, { color: theme.textMuted }]}>{copy("mobile_chat_tool_output_truncated")}</Text>
      )}
      <Text selectable style={[styles.code, { color: theme.textMuted }]}>
        {output.text}
      </Text>
    </View>
  )
}

export function FileChangeRow({ path }: { path: string }) {
  const theme = useTheme()
  return (
    <View style={styles.row}>
      <Icon name="FileDiff" size={ICON_SIZE} color={theme.textMuted} />
      <Text numberOfLines={1} ellipsizeMode="middle" style={[styles.label, { color: theme.textMuted }]}>
        {copy("mobile_chat_edited", { path })}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { minHeight: ROW_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8 },
  label: { flex: 1, fontSize: 14 },
  mono: { fontFamily: mono, fontSize: 13 },
  details: { marginLeft: ICON_SIZE + 8, marginBottom: 6, gap: 4 },
  heading: { fontSize: 12, fontWeight: "500" },
  block: { borderRadius: radius.sm, padding: 8 },
  code: { fontFamily: mono, fontSize: 12, lineHeight: 17 },
  commandOutput: { marginTop: 8 },
  shown: { gap: 4 },
  note: { fontSize: 12 },
  failed: { flexDirection: "row", alignItems: "center", gap: 8 },
  failedText: { flex: 1 },
})
