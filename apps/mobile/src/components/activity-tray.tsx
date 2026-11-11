import { isThreadBusy, type Message, type Thread } from "@shared/domain.ts"
import { inFlight } from "@shared/subagents.ts"
import { visibleTodos } from "@shared/todos.ts"
import { useState } from "react"
import { StyleSheet, View } from "react-native"
import { SubagentActivity } from "@/components/subagents"
import { TodoActivity } from "@/components/todo-tray"
import { radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { useThreadSubagents } from "@/stores/subagents"

type Line = "subagents" | "todos"

export function ActivityTray({ thread, messages }: { thread: Thread; messages: readonly Message[] | undefined }) {
  const theme = useTheme()
  const [open, setOpen] = useState<Line | null>(null)
  const subagents = inFlight(useThreadSubagents(thread.id))
  const todos = messages === undefined ? [] : visibleTodos(messages, isThreadBusy(thread.status))
  if (subagents.length === 0 && todos.length === 0) return null
  const toggle = (line: Line) => setOpen(open === line ? null : line)

  return (
    <View
      testID="activity-tray"
      accessibilityLabel={copy("mobile_chat_activity_label")}
      style={[styles.tray, { borderColor: theme.border, backgroundColor: theme.background }]}
    >
      {subagents.length > 0 && (
        <SubagentActivity
          threadId={thread.id}
          subagents={subagents}
          expanded={open === "subagents"}
          onToggle={() => toggle("subagents")}
        />
      )}
      {subagents.length > 0 && todos.length > 0 && (
        <View style={[styles.divider, { backgroundColor: theme.border }]} />
      )}
      {todos.length > 0 && (
        <TodoActivity todos={todos} expanded={open === "todos"} onToggle={() => toggle("todos")} />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  tray: {
    marginHorizontal: 32,
    marginBottom: -4,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    overflow: "hidden",
  },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 12 },
})
