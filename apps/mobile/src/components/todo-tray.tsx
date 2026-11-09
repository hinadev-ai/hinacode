import type { Todo, TodoStatus } from "@shared/todos.ts"
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { FadeIn, Rotate, Spinner } from "@/components/motion"
import { ActivityMeter, LINE_HEIGHT } from "@/components/activity-meter"
import type { Palette } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const ROW_HEIGHT = 28
const VISIBLE_ROWS = 5.5

const statusIcon: Record<Exclude<TodoStatus, "in_progress">, IconName> = {
  pending: "Circle",
  completed: "CheckCircle",
  cancelled: "XCircle",
}

const todoKeys = (todos: ReadonlyArray<Todo>): Array<[string, Todo]> => {
  const seen = new Map<string, number>()
  return todos.map((todo) => {
    const count = seen.get(todo.text) ?? 0
    seen.set(todo.text, count + 1)
    return [count === 0 ? todo.text : `${todo.text}#${count}`, todo]
  })
}

const todoColor = (theme: Palette, status: TodoStatus) =>
  status === "completed" ? theme.textMuted : status === "in_progress" ? theme.token : theme.border

function TodoIcon({ status }: { status: TodoStatus }) {
  const theme = useTheme()
  if (status === "in_progress") return <Spinner size={14} color={theme.text} />
  return <Icon name={statusIcon[status]} size={14} color={theme.textMuted} />
}

function TodoRow({ todo }: { todo: Todo }) {
  const theme = useTheme()
  const settled = todo.status === "completed" || todo.status === "cancelled"
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <TodoIcon status={todo.status} />
      </View>
      <Text
        style={[
          styles.rowText,
          { color: settled ? theme.textMuted : theme.text },
          todo.status === "completed" && styles.struck,
        ]}
      >
        {todo.text}
      </Text>
    </View>
  )
}

/** The agent's task list as one line of the activity tray: progress and the current task, expanding to the full list. */
export function TodoActivity({
  todos,
  expanded,
  onToggle,
}: {
  todos: readonly Todo[]
  expanded: boolean
  onToggle: () => void
}) {
  const theme = useTheme()
  const done = todos.filter((todo) => todo.status === "completed").length
  const current = todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending")
  const progress = copy("mobile_chat_todos_progress", { done: String(done), total: String(todos.length) })

  return (
    <View testID="todo-activity">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${copy("mobile_chat_todos_label")}, ${progress}`}
        aria-expanded={expanded}
        onPress={onToggle}
        style={styles.header}
      >
        <ActivityMeter
          segments={todoKeys(todos).map(([key, todo]) => ({ key, color: todoColor(theme, todo.status) }))}
        />
        <Text style={[styles.progress, { color: theme.textMuted }]}>{progress}</Text>
        {current !== undefined && (
          <View style={styles.current}>
            <TodoIcon status={current.status} />
            <Text numberOfLines={1} style={[styles.currentText, { color: theme.text }]}>
              {current.text}
            </Text>
          </View>
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
            accessibilityLabel={copy("mobile_chat_todos_label")}
            style={{ maxHeight: ROW_HEIGHT * VISIBLE_ROWS }}
            contentContainerStyle={styles.list}
          >
            {todoKeys(todos).map(([key, todo]) => (
              <TodoRow key={key} todo={todo} />
            ))}
          </ScrollView>
        </FadeIn>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  header: { minHeight: LINE_HEIGHT, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 8 },
  progress: { fontSize: 13, fontVariant: ["tabular-nums"] },
  current: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  currentText: { flexShrink: 1, fontSize: 13 },
  chevron: { marginLeft: "auto" },
  list: { paddingHorizontal: 12, paddingBottom: 8 },
  row: { minHeight: ROW_HEIGHT, flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 4 },
  rowIcon: { height: 18, justifyContent: "center" },
  rowText: { flexShrink: 1, fontSize: 13, lineHeight: 18 },
  struck: { textDecorationLine: "line-through" },
})
