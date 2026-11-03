import { useAtomValue } from "@effect/atom-react"
import { WarningIcon } from "@hinacode/icons"
import { Image } from "@tiptap/extension-image"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { TableKit } from "@tiptap/extension-table"
import { Placeholder } from "@tiptap/extensions"
import { Markdown } from "@tiptap/markdown"
import { EditorContent, useEditor } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useState } from "react"
import type { Artifact, DocumentContent } from "../../../shared/artifact.ts"
import { useTheme } from "../../lib/appearance.ts"
import { CodeHighlight, codeHighlightKey, type CodeTheme } from "./codeHighlight.ts"
import { LinkEditing } from "./linkEditing.ts"
import { createDocumentSync, type DocumentSync, type SaveStatus } from "./documentSync.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { documentAtom, onPushEvent } from "../../lib/rpc.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { useDrafts } from "../../stores/drafts.ts"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"
import { DocumentCodeBlock } from "./DocumentCodeBlock.tsx"
import "./documentEditor.css"
import { LinkEditor, LinkHoverCard } from "./DocumentLinks.tsx"
import { liveDocumentKey, printableHtml, showLiveDocument } from "./liveDocuments.ts"
import { DocumentToolbar, SelectionMenu, TableMenu } from "./DocumentToolbar.tsx"

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
    codeBlock: false,
  }),
  DocumentCodeBlock,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  Image,
  Markdown,
  Placeholder.configure({ placeholder }),
  LinkEditing,
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

  useEffect(
    () =>
      showLiveDocument(liveDocumentKey(artifact.environmentId, artifact.id), {
        html: () => printableHtml(editor.view.dom),
        markdown: () => editor.getMarkdown(),
      }),
    [editor, artifact.environmentId, artifact.id],
  )

  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(codeHighlightKey, { theme: { codeTheme, scheme } }))
  }, [editor, codeTheme, scheme])

  return (
    <div className="flex min-h-0 flex-1 flex-col transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-x-2">
      <DocumentToolbar editor={editor} />
      <SelectionMenu editor={editor} />
      <LinkHoverCard editor={editor} />
      <LinkEditor editor={editor} />
      <TableMenu editor={editor} />
      {status.type === "conflict" && <ConflictBanner sync={sync} />}
      <ScrollArea className="min-h-0 flex-1">
        <EditorContent
          editor={editor}
          className="h-full"
          onKeyDown={(event) => {
            if (event.defaultPrevented) event.stopPropagation()
          }}
        />
      </ScrollArea>
      <DocumentFooter threadId={threadId} artifact={artifact} status={status} sync={sync} />
    </div>
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
  const askAgent = async () => {
    const revision = await sync.savedRevision()
    const prompt = m.documents_ask_prompt({ title: artifact.title, id: artifact.id, revision })
    setText(threadId, draft.trim() === "" ? prompt : `${draft.trimEnd()}\n\n${prompt}`)
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
      <p
        className={`min-w-0 flex-1 truncate text-xs ${status.type === "failed" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {status.type === "failed" ? <span role="alert">{statusText(status)}</span> : statusText(status)}
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
