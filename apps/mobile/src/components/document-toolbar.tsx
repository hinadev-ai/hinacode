import { linkHref } from "@shared/documentLink.ts"
import type { DocumentAction, DocumentActionType, SelectionState } from "@hinacode/document-view"
import { Fragment, useState } from "react"
import { ScrollView, StyleSheet, TextInput, View } from "react-native"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale, Spinner } from "@/components/motion"
import { Sheet } from "@/components/sheet"
import { Button } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

type Label = Parameters<typeof copy>[0]

type Tool = {
  readonly icon: IconName
  readonly label: Label
  readonly action: DocumentAction
  readonly active?: (selection: SelectionState) => boolean
}

type BlockToggle = Exclude<Extract<DocumentActionType, `toggle${string}`>, "toggleHeading">

const toggle = (icon: IconName, label: Label, type: BlockToggle): Tool => ({
  icon,
  label,
  action: { type },
  active: (selection) => selection.active.includes(type),
})

const heading = (level: 1 | 2 | 3, icon: IconName, label: Label): Tool => ({
  icon,
  label,
  action: { type: "toggleHeading", level },
  active: (selection) => selection.heading === level,
})

const history: readonly Tool[] = [
  { icon: "RiArrowGoBackLine", label: "mobile_document_undo", action: { type: "undo" } },
  { icon: "RiArrowGoForwardLine", label: "mobile_document_redo", action: { type: "redo" } },
]

const blocks: readonly Tool[] = [
  heading(1, "RiH1", "mobile_document_heading_1"),
  heading(2, "RiH2", "mobile_document_heading_2"),
  heading(3, "RiH3", "mobile_document_heading_3"),
  toggle("RiListUnordered", "mobile_document_bullet_list", "toggleBulletList"),
  toggle("RiListOrdered", "mobile_document_ordered_list", "toggleOrderedList"),
  toggle("RiListCheck3", "mobile_document_task_list", "toggleTaskList"),
  toggle("RiDoubleQuotesL", "mobile_document_quote", "toggleBlockquote"),
  toggle("Info", "mobile_document_callout", "toggleCallout"),
  toggle("RiCodeBoxLine", "mobile_document_code_block", "toggleCodeBlock"),
]

const nesting: readonly Tool[] = [
  { icon: "RiIndentIncrease", label: "mobile_document_indent", action: { type: "sinkListItem" } },
  { icon: "RiIndentDecrease", label: "mobile_document_outdent", action: { type: "liftListItem" } },
]

const tableEdits: readonly Tool[] = [
  { icon: "RiInsertRowBottom", label: "mobile_document_add_row", action: { type: "addRowAfter" } },
  { icon: "RiInsertColumnRight", label: "mobile_document_add_column", action: { type: "addColumnAfter" } },
  { icon: "RiDeleteRow", label: "mobile_document_delete_row", action: { type: "deleteRow" } },
  { icon: "RiDeleteColumn", label: "mobile_document_delete_column", action: { type: "deleteColumn" } },
  { icon: "RiDeleteBin6Line", label: "mobile_document_delete_table", action: { type: "deleteTable" } },
]

const insertTable: Tool = { icon: "RiTable2", label: "mobile_document_insert_table", action: { type: "insertTable" } }

export function DocumentToolbar({
  selection,
  imageBusy,
  onRun,
  onImage,
  onLink,
  onHideKeyboard,
}: {
  selection: SelectionState | null
  imageBusy: boolean
  onRun: (action: DocumentAction) => void
  onImage: () => void
  onLink: () => void
  onHideKeyboard: () => void
}) {
  const theme = useTheme()
  const allows = (type: DocumentActionType) => selection === null || selection.available.includes(type)
  const inTable = selection?.available.includes("deleteTable") === true
  const groups: (readonly Tool[])[] = [
    history,
    blocks,
    nesting.filter((tool) => selection?.available.includes(tool.action.type) === true),
    inTable ? tableEdits : [insertTable],
  ]
  const tool = ({ icon, label, action, active }: Tool) => (
    <ToolButton
      key={label}
      icon={icon}
      label={copy(label)}
      active={selection !== null && active?.(selection) === true}
      disabled={!allows(action.type)}
      onPress={() => onRun(action)}
    />
  )
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={copy("mobile_document_toolbar")}
      style={[styles.bar, { backgroundColor: theme.card, borderColor: theme.border }]}
    >
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.tools}
        contentContainerStyle={styles.row}
      >
        {groups
          .filter((group) => group.length > 0)
          .map((group, index) => (
            <Fragment key={group[0]!.label}>
              {index > 0 && <View style={[styles.divider, { backgroundColor: theme.border }]} />}
              {group.map(tool)}
            </Fragment>
          ))}
        <ToolButton
          icon="Image"
          label={copy("mobile_document_image")}
          busy={imageBusy}
          disabled={imageBusy || !allows("insertImage")}
          onPress={onImage}
        />
        <ToolButton
          icon="RiLink"
          label={copy("mobile_document_link")}
          active={selection?.active.includes("setLink") === true}
          disabled={!allows("setLink")}
          onPress={onLink}
        />
      </ScrollView>
      <View style={[styles.pinned, { borderColor: theme.border }]}>
        <ToolButton
          icon="RiKeyboardBoxLine"
          label={copy("mobile_document_hide_keyboard")}
          disabled={false}
          onPress={onHideKeyboard}
        />
      </View>
    </View>
  )
}

function ToolButton({
  icon,
  label,
  active = false,
  disabled,
  busy = false,
  onPress,
}: {
  icon: IconName
  label: string
  active?: boolean
  disabled: boolean
  busy?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  const color = disabled ? theme.textMuted : active ? theme.primary : theme.text
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-selected={active}
      aria-disabled={disabled}
      aria-busy={busy}
      disabled={disabled}
      onPress={onPress}
      style={[styles.tool, active && { backgroundColor: theme.inkWash }, disabled && styles.disabled]}
    >
      {busy ? <Spinner size={18} color={color} /> : <Icon name={icon} size={20} color={color} />}
    </PressableScale>
  )
}

export function LinkSheet({
  href,
  onSave,
  onClose,
}: {
  href: string | null
  onSave: (href: string | null) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const [text, setText] = useState(href ?? "")
  const target = linkHref(text)
  const save = () => {
    if (target !== null) onSave(target)
  }
  return (
    <Sheet title={copy("mobile_document_link_edit")} open onClose={onClose} fit>
      <View style={styles.form}>
        <TextInput
          testID="document-link-input"
          accessibilityLabel={copy("mobile_document_link")}
          placeholder={copy("mobile_document_link_placeholder")}
          placeholderTextColor={theme.textMuted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={save}
          autoFocus
          selectTextOnFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          style={[styles.input, { color: theme.text, backgroundColor: theme.card, borderColor: theme.border }]}
        />
        <View style={styles.actions}>
          {href !== null && (
            <Button
              testID="document-link-remove"
              label={copy("mobile_document_link_remove")}
              variant="dangerGhost"
              onPress={() => onSave(null)}
              style={styles.action}
            />
          )}
          <Button
            testID="document-link-save"
            label={copy("mobile_document_link_save")}
            variant="primary"
            disabled={target === null}
            onPress={save}
            style={styles.action}
          />
        </View>
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth },
  tools: { flex: 1 },
  pinned: { paddingHorizontal: 4, borderLeftWidth: StyleSheet.hairlineWidth },
  row: { alignItems: "center", paddingHorizontal: 4 },
  divider: { width: StyleSheet.hairlineWidth, height: 24, marginHorizontal: 4 },
  tool: {
    width: HIT,
    height: HIT,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  disabled: { opacity: 0.4 },
  form: { gap: 12 },
  input: {
    minHeight: HIT + 8,
    paddingHorizontal: 16,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
  actions: { flexDirection: "row", gap: 8 },
  action: { flex: 1, borderRadius: radius.full },
})
