import { useAtomValue } from "@effect/atom-react"
import { TrashIcon, WarningIcon } from "@hinacode/icons"
import type { Editor } from "@tiptap/core"
import { Image } from "@tiptap/extension-image"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { TableKit } from "@tiptap/extension-table"
import { Placeholder } from "@tiptap/extensions"
import { Markdown } from "@tiptap/markdown"
import { EditorContent, useEditor, useEditorState } from "@tiptap/react"
import { BubbleMenu } from "@tiptap/react/menus"
import { StarterKit } from "@tiptap/starter-kit"
import { AsyncResult } from "effect/reactivity"
import { type ComponentType, useEffect, useState } from "react"
import {
  RiBold,
  RiCodeBoxLine,
  RiCodeLine,
  RiDoubleQuotesL,
  RiH1,
  RiH2,
  RiH3,
  RiInsertColumnRight,
  RiInsertRowBottom,
  RiItalic,
  RiListCheck3,
  RiListOrdered,
  RiListUnordered,
  RiStrikethrough,
  RiTable2,
} from "react-icons/ri"
import type { Artifact, DocumentContent } from "../../../shared/artifact.ts"
import { useTheme } from "../../lib/appearance.ts"
import { CodeHighlight, codeHighlightKey, type CodeTheme } from "../../lib/documentCodeHighlight.ts"
import { createDocumentSync, type DocumentSync, type SaveStatus } from "../../lib/documentSync.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { documentAtom, onPushEvent } from "../../lib/rpc.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { useDrafts } from "../../stores/drafts.ts"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"

const loadFailed = (message: string) => (
  <p role="alert" className="p-4 text-xs wrap-anywhere text-destructive">
    {m.documents_load_failed({ message })}
  </p>
)

export function DocumentView({ threadId, artifact }: { threadId: string; artifact: Artifact }) {
  const content = useAtomValue(documentAtom(artifact.environmentId ?? null, artifact.id))
  return AsyncResult.builder(content)
    .onInitial(() => <p className="animate-reveal p-4 text-xs text-muted-foreground">{m.documents_loading()}</p>)
    .onSuccess((loaded) => <DocumentEditor threadId={threadId} artifact={artifact} loaded={loaded} />)
    .onError((error) => loadFailed(errorMessage(error)))
    .orElse(() => loadFailed(""))
}

const extensions = (placeholder: string, theme: CodeTheme) => [
  StarterKit.configure({
    underline: false,
    link: { openOnClick: false },
    codeBlock: { HTMLAttributes: { spellcheck: "false" } },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Image,
  Markdown,
  Placeholder.configure({ placeholder }),
  CodeHighlight.configure({ theme }),
]

function DocumentEditor({
  threadId,
  artifact,
  loaded,
}: {
  threadId: string
  artifact: Artifact
  loaded: DocumentContent
}) {
  const [status, setStatus] = useState<SaveStatus>({ type: "saved" })
  const { codeTheme, scheme } = useTheme(useClientSettings().appearance.theme)
  const [initialTheme] = useState<CodeTheme>({ codeTheme, scheme })
  const [sync] = useState(() =>
    createDocumentSync({
      id: artifact.id,
      environment: artifact.environmentId ?? null,
      loaded,
      onStatus: setStatus,
    }),
  )
  const editor = useEditor({
    extensions: extensions(m.documents_placeholder(), initialTheme),
    content: sync.initial,
    contentType: "markdown",
    onCreate: ({ editor: created }) => sync.start(created),
    onUpdate: ({ transaction }) => {
      if (transaction.docChanged) sync.edited()
    },
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": artifact.title,
        "data-document-id": artifact.id,
        class: "hina-document prose-hina prose max-w-none min-h-full py-5 outline-none",
      },
    },
  })

  useEffect(() => {
    const stop = onPushEvent((event) => {
      if (event.type === "artifact.updated" && event.artifact.id === artifact.id)
        void sync.published(event.artifact.revision)
    })
    return () => {
      stop()
      sync.flush()
    }
  }, [artifact.id, sync])

  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(codeHighlightKey, { theme: { codeTheme, scheme } }))
  }, [editor, codeTheme, scheme])

  return (
    <div className="flex min-h-0 flex-1 flex-col transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-x-2">
      <DocumentToolbar editor={editor} />
      <SelectionMenu editor={editor} />
      {status.type === "conflict" && <ConflictBanner sync={sync} />}
      <ScrollArea className="min-h-0 flex-1">
        <EditorContent editor={editor} className="h-full" />
      </ScrollArea>
      <DocumentFooter threadId={threadId} artifact={artifact} status={status} sync={sync} />
    </div>
  )
}

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
    id: "deleteTable",
    label: m.documents_delete_table,
    icon: TrashIcon,
    run: (editor) => editor.chain().focus().deleteTable().run(),
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

const allTools = [...headings, ...lists, ...blocks, ...marks]

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

function DocumentToolbar({ editor }: { editor: Editor }) {
  const { active, inTable } = useActiveTools(editor)
  const groups = [headings, lists, inTable ? [...blocks, ...tableTools] : [...blocks, insertTable]]
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

function SelectionMenu({ editor }: { editor: Editor }) {
  const { active } = useActiveTools(editor)
  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: current, from, to }) =>
        from !== to && current.isEditable && !current.isActive("codeBlock") && !current.state.selection.empty
      }
    >
      <div
        role="toolbar"
        aria-label={m.documents_selection_toolbar()}
        className="origin-bottom rounded-lg border border-border bg-popover p-0.5 shadow-md transition-[opacity,scale] duration-150 ease-out starting:opacity-0 motion-safe:starting:scale-96"
      >
        <ToolGroup editor={editor} tools={marks} active={active} />
      </div>
    </BubbleMenu>
  )
}

function ConflictBanner({ sync }: { sync: DocumentSync }) {
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-attention/30 bg-attention/5 px-3 py-2 transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:-translate-y-1"
    >
      <WarningIcon aria-hidden className="size-4 shrink-0 text-attention" />
      <p className="min-w-0 flex-1 text-xs">{m.documents_conflict()}</p>
      <div className="flex shrink-0 gap-1.5">
        <Button variant="outline" size="xs" action={sync.useTheirs}>
          {m.documents_use_theirs()}
        </Button>
        <Button size="xs" action={sync.keepMine}>
          {m.documents_keep_mine()}
        </Button>
      </div>
    </div>
  )
}

const statusText = (status: SaveStatus) => {
  switch (status.type) {
    case "saved":
      return m.documents_saved()
    case "saving":
      return m.documents_saving()
    case "conflict":
      return m.documents_not_saved()
    case "failed":
      return m.documents_save_failed({ message: status.message })
  }
}

function DocumentFooter({
  threadId,
  artifact,
  status,
  sync,
}: {
  threadId: string
  artifact: Artifact
  status: SaveStatus
  sync: DocumentSync
}) {
  const draft = useDrafts((state) => state.byThreadId[threadId]?.text ?? "")
  const setText = useDrafts((state) => state.setText)
  const askAgent = () => {
    const prompt = m.documents_ask_prompt({ title: artifact.title, id: artifact.id, revision: sync.revision() })
    setText(threadId, draft.trim() === "" ? prompt : `${draft.trimEnd()}\n\n${prompt}`)
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
      <p
        aria-live="polite"
        className={`min-w-0 flex-1 truncate text-xs ${status.type === "failed" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {statusText(status)}
      </p>
      {status.type === "failed" && (
        <Button variant="outline" size="xs" action={sync.retry}>
          {m.sidebar_retry()}
        </Button>
      )}
      <Button variant="outline" size="xs" action={askAgent}>
        {m.documents_ask_agent()}
      </Button>
    </div>
  )
}
