import { useAtomValue } from "@effect/atom-react"
import { TrashIcon } from "@hinacode/icons"
import type { Editor } from "@tiptap/core"
import { Image } from "@tiptap/extension-image"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { TableKit } from "@tiptap/extension-table"
import { Placeholder } from "@tiptap/extensions"
import { Markdown } from "@tiptap/markdown"
import { EditorContent, useEditor, useEditorState } from "@tiptap/react"
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
import { createDocumentSync, type DocumentSync, type SaveStatus } from "../../lib/documentSync.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { documentAtom, onPushEvent } from "../../lib/rpc.ts"
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

const extensions = (placeholder: string) => [
  StarterKit.configure({ underline: false, link: { openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Image,
  Markdown,
  Placeholder.configure({ placeholder }),
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
  const [sync] = useState(() =>
    createDocumentSync({
      id: artifact.id,
      environment: artifact.environmentId ?? null,
      loaded,
      onStatus: setStatus,
    }),
  )
  const editor = useEditor({
    extensions: extensions(m.documents_placeholder()),
    content: sync.initial,
    contentType: "markdown",
    onCreate: ({ editor: created }) => sync.start(created),
    onUpdate: () => sync.edited(),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": artifact.title,
        class: "hina-document prose-hina prose max-w-none min-h-full px-6 py-4 outline-none",
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocumentToolbar editor={editor} />
      {status.type === "conflict" && <ConflictBanner sync={sync} />}
      <ScrollArea className="min-h-0 flex-1">
        <EditorContent editor={editor} className="h-full" />
      </ScrollArea>
      <DocumentFooter threadId={threadId} artifact={artifact} status={status} sync={sync} />
    </div>
  )
}

type Tool = {
  readonly label: () => string
  readonly icon: ComponentType<{ "aria-hidden": boolean }>
  readonly active?: (editor: Editor) => boolean
  readonly run: (editor: Editor) => void
}

const formatting: ReadonlyArray<Tool> = [
  {
    label: m.documents_heading_1,
    icon: RiH1,
    active: (editor) => editor.isActive("heading", { level: 1 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: m.documents_heading_2,
    icon: RiH2,
    active: (editor) => editor.isActive("heading", { level: 2 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: m.documents_heading_3,
    icon: RiH3,
    active: (editor) => editor.isActive("heading", { level: 3 }),
    run: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: m.documents_bold,
    icon: RiBold,
    active: (editor) => editor.isActive("bold"),
    run: (editor) => editor.chain().focus().toggleBold().run(),
  },
  {
    label: m.documents_italic,
    icon: RiItalic,
    active: (editor) => editor.isActive("italic"),
    run: (editor) => editor.chain().focus().toggleItalic().run(),
  },
  {
    label: m.documents_strike,
    icon: RiStrikethrough,
    active: (editor) => editor.isActive("strike"),
    run: (editor) => editor.chain().focus().toggleStrike().run(),
  },
  {
    label: m.documents_code,
    icon: RiCodeLine,
    active: (editor) => editor.isActive("code"),
    run: (editor) => editor.chain().focus().toggleCode().run(),
  },
  {
    label: m.documents_bullet_list,
    icon: RiListUnordered,
    active: (editor) => editor.isActive("bulletList"),
    run: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: m.documents_ordered_list,
    icon: RiListOrdered,
    active: (editor) => editor.isActive("orderedList"),
    run: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: m.documents_task_list,
    icon: RiListCheck3,
    active: (editor) => editor.isActive("taskList"),
    run: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    label: m.documents_quote,
    icon: RiDoubleQuotesL,
    active: (editor) => editor.isActive("blockquote"),
    run: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    label: m.documents_code_block,
    icon: RiCodeBoxLine,
    active: (editor) => editor.isActive("codeBlock"),
    run: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
]

const insertTable: Tool = {
  label: m.documents_insert_table,
  icon: RiTable2,
  run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
}

const tableTools: ReadonlyArray<Tool> = [
  { label: m.documents_add_row, icon: RiInsertRowBottom, run: (editor) => editor.chain().focus().addRowAfter().run() },
  {
    label: m.documents_add_column,
    icon: RiInsertColumnRight,
    run: (editor) => editor.chain().focus().addColumnAfter().run(),
  },
  { label: m.documents_delete_table, icon: TrashIcon, run: (editor) => editor.chain().focus().deleteTable().run() },
]

function DocumentToolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      active: formatting.map((tool) => tool.active?.(current) ?? false),
      inTable: current.isActive("table"),
    }),
  })
  const tools = state.inTable ? [...formatting, ...tableTools] : [...formatting, insertTable]
  return (
    <div
      role="toolbar"
      aria-label={m.documents_toolbar()}
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border px-2 py-1"
    >
      {tools.map((tool, index) => {
        const Icon = tool.icon
        const pressed = tool.active === undefined ? undefined : (state.active[index] ?? false)
        return (
          <Button
            key={tool.label()}
            variant="ghost"
            size="icon-sm"
            aria-label={tool.label()}
            title={tool.label()}
            aria-pressed={pressed}
            className="aria-pressed:bg-muted aria-pressed:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => tool.run(editor)}
          >
            <Icon aria-hidden />
          </Button>
        )
      })}
    </div>
  )
}

function ConflictBanner({ sync }: { sync: DocumentSync }) {
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2">
      <p className="min-w-0 flex-1 text-xs">{m.documents_conflict()}</p>
      <Button variant="outline" size="xs" action={sync.useTheirs}>
        {m.documents_use_theirs()}
      </Button>
      <Button size="xs" action={sync.keepMine}>
        {m.documents_keep_mine()}
      </Button>
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
