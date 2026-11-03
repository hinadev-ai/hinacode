import type { Editor } from "@tiptap/core"
import { CellSelection } from "@tiptap/pm/tables"
import { useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { TrashIcon } from "@hinacode/icons"
import type { ComponentType } from "react"
import {
  RiBold,
  RiCodeBoxLine,
  RiCodeLine,
  RiDeleteColumn,
  RiDeleteRow,
  RiDoubleQuotesL,
  RiH1,
  RiH2,
  RiH3,
  RiInsertColumnRight,
  RiInsertRowBottom,
  RiItalic,
  RiLink,
  RiListCheck3,
  RiListOrdered,
  RiListUnordered,
  RiStrikethrough,
  RiTable2,
} from "react-icons/ri"
import { editedLink, editLink, selectedLinkRange } from "../../lib/documentLinks.ts"
import { m } from "../../paraglide/messages.js"
import { Button } from "../ui/button.tsx"

type Tool = {
  readonly id: string
  readonly label: () => string
  readonly icon: ComponentType<{ "aria-hidden": boolean }>
  readonly active?: (editor: Editor) => boolean
  readonly run: (editor: Editor) => void
}

const heading = (level: 1 | 2 | 3, label: () => string, icon: Tool["icon"]): Tool => ({
  id: `heading-${level}`,
  label,
  icon,
  active: (editor) => editor.isActive("heading", { level }),
  run: (editor) => editor.chain().focus().toggleHeading({ level }).run(),
})

const headings: ReadonlyArray<Tool> = [
  heading(1, m.documents_heading_1, RiH1),
  heading(2, m.documents_heading_2, RiH2),
  heading(3, m.documents_heading_3, RiH3),
]

const lists: ReadonlyArray<Tool> = [
  {
    id: "bulletList",
    label: m.documents_bullet_list,
    icon: RiListUnordered,
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    id: "orderedList",
    label: m.documents_ordered_list,
    icon: RiListOrdered,
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    id: "taskList",
    label: m.documents_task_list,
    icon: RiListCheck3,
    active: (editor) => editor.isActive("taskList"),
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
]

const blocks: ReadonlyArray<Tool> = [
  {
    id: "blockquote",
    label: m.documents_quote,
    icon: RiDoubleQuotesL,
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    id: "codeBlock",
    label: m.documents_code_block,
    icon: RiCodeBoxLine,
    active: (editor) => editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
]

const insertTable: Tool = {
  id: "insertTable",
  label: m.documents_insert_table,
  icon: RiTable2,
  run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
}

const tableTools: ReadonlyArray<Tool> = [
  {
    id: "addRow",
    label: m.documents_add_row,
    icon: RiInsertRowBottom,
    run: (editor) => editor.chain().focus().addRowAfter().run(),
  },
  {
    id: "addColumn",
    label: m.documents_add_column,
    icon: RiInsertColumnRight,
    run: (editor) => editor.chain().focus().addColumnAfter().run(),
  },
  {
    id: "deleteRow",
    label: m.documents_delete_row,
    icon: RiDeleteRow,
    run: (editor) => editor.chain().focus().deleteRow().run(),
  },
  {
    id: "deleteColumn",
    label: m.documents_delete_column,
    icon: RiDeleteColumn,
    run: (editor) => editor.chain().focus().deleteColumn().run(),
  },
]

const marks: ReadonlyArray<Tool> = [
  {
    id: "bold",
    label: m.documents_bold,
    icon: RiBold,
    active: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    id: "italic",
    label: m.documents_italic,
    icon: RiItalic,
    active: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    id: "strike",
    label: m.documents_strike,
    icon: RiStrikethrough,
    active: (editor) => editor.isActive("strike"),
    run: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    id: "code",
    label: m.documents_code,
    icon: RiCodeLine,
    active: (editor) => editor.isActive("code"),
    run: (editor) => editor.chain().focus().toggleCode().run(),
  },
]

const link: Tool = {
  id: "link",
  label: m.documents_link,
  icon: RiLink,
  active: (editor) => editor.isActive("link"),
  run: (editor) => editLink(editor, selectedLinkRange(editor)),
}

const allTools = [...headings, ...lists, ...blocks, ...marks, link]

function useActiveTools(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      active: Object.fromEntries(allTools.map((tool) => [tool.id, tool.active?.(current) ?? false])),
      inTable: current.isActive("table"),
    }),
  })
}

function ToolButton({ editor, tool, active }: { editor: Editor; tool: Tool; active: boolean | undefined }) {
  const Icon = tool.icon
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={tool.label()}
      title={tool.label()}
      aria-pressed={active}
      className="aria-pressed:bg-muted aria-pressed:text-foreground"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => tool.run(editor)}
    >
      <Icon aria-hidden />
    </Button>
  )
}

function ToolGroup({
  editor,
  tools,
  active,
}: {
  editor: Editor
  tools: ReadonlyArray<Tool>
  active: Record<string, boolean>
}) {
  return (
    <div className="flex items-center gap-0.5">
      {tools.map((tool) => (
        <ToolButton
          key={tool.id}
          editor={editor}
          tool={tool}
          active={tool.active === undefined ? undefined : (active[tool.id] ?? false)}
        />
      ))}
    </div>
  )
}

export function DocumentToolbar({ editor }: { editor: Editor }) {
  const { active, inTable } = useActiveTools(editor)
  const groups = [headings, lists, inTable ? blocks : [...blocks, insertTable]]
  return (
    <div
      role="toolbar"
      aria-label={m.documents_toolbar()}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2 py-1"
    >
      {groups.map((tools) => (
        <ToolGroup key={tools[0]?.id} editor={editor} tools={tools} active={active} />
      ))}
    </div>
  )
}

const floatingSurface =
  "origin-bottom rounded-lg border border-border bg-popover p-0.5 shadow-md transition-[opacity,scale] duration-150 ease-out starting:opacity-0 motion-safe:starting:scale-96"

export function SelectionMenu({ editor }: { editor: Editor }) {
  const { active } = useActiveTools(editor)
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionMenu"
      shouldShow={({ editor: current, state }) =>
        current.isEditable &&
        !state.selection.empty &&
        !(state.selection instanceof CellSelection) &&
        !current.isActive("codeBlock") &&
        editedLink(current) === null
      }
    >
      <div role="toolbar" aria-label={m.documents_selection_toolbar()} className={floatingSurface}>
        <ToolGroup editor={editor} tools={[...marks, link]} active={active} />
      </div>
    </BubbleMenu>
  )
}

const selectedTable = (editor: Editor) => {
  const { node } = editor.view.domAtPos(editor.state.selection.from)
  const element = node instanceof Element ? node : node.parentElement
  return element?.closest("table") ?? null
}

export function TableMenu({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      options={{ placement: "top-end", offset: 6 }}
      getReferencedVirtualElement={() => {
        const table = selectedTable(editor)
        return table === null ? null : { getBoundingClientRect: () => table.getBoundingClientRect() }
      }}
      shouldShow={({ editor: current, state }) =>
        current.isEditable &&
        current.isActive("table") &&
        (state.selection.empty || state.selection instanceof CellSelection)
      }
    >
      <div
        role="toolbar"
        aria-label={m.documents_table_menu()}
        className={`${floatingSurface} flex items-center gap-0.5`}
      >
        <ToolGroup editor={editor} tools={tableTools} active={{}} />
        <Button
          variant="ghost"
          size="xs"
          className="text-destructive hover:text-destructive"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor.chain().focus().deleteTable().run()}
        >
          <TrashIcon aria-hidden />
          {m.documents_delete_table()}
        </Button>
      </div>
    </BubbleMenu>
  )
}
