import { useAtomValue } from "@effect/atom-react"
import { FeedbackIcon, WarningIcon } from "@hinacode/icons"
import { TaskItem, TaskList } from "@tiptap/extension-list"
import { TableKit } from "@tiptap/extension-table"
import { Placeholder } from "@tiptap/extensions"
import { Markdown } from "@tiptap/markdown"
import { EditorContent, useEditor, useEditorState } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { AsyncResult } from "effect/reactivity"
import { toast } from "sonner"
import { type ReactNode, useEffect, useRef, useState, useTransition } from "react"
import type { Artifact, ArtifactComment, DocumentContent } from "../../../shared/artifact.ts"
import { useTheme } from "../../lib/appearance.ts"
import { CodeHighlight, codeHighlightKey, type CodeTheme } from "./codeHighlight.ts"
import { commentDetachedIds, CommentHighlights } from "./commentHighlight.ts"
import { LinkEditing } from "./linkEditing.ts"
import { createDocumentSync, type DocumentSync, type SaveStatus } from "./documentSync.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { cn } from "../../lib/utils.ts"
import { readAsDataUrl } from "../../lib/dataUrl.ts"
import { callPromise, documentAtom, type EnvironmentId, onPushEvent } from "../../lib/rpc.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { useDrafts } from "../../stores/drafts.ts"
import { Button } from "../ui/button.tsx"
import { ScrollArea } from "../ui/scroll-area.tsx"
import { DocumentBlockquote, DocumentCallout } from "./DocumentCallout.tsx"
import { DocumentCodeBlock } from "./DocumentCodeBlock.tsx"
import { DocumentImage } from "./documentImage.ts"
import { DocumentPaste } from "./documentPaste.ts"
import "./documentEditor.css"
import { LinkEditor, LinkHoverCard } from "./DocumentLinks.tsx"
import { liveDocumentKey, printableHtml, showLiveDocument } from "./liveDocuments.ts"
import { DocumentToolbar, SelectionMenu, TableMenu } from "./DocumentToolbar.tsx"
import { loadedFeedback, useFeedback, useFeedbackActions } from "../artifactComments/feedback.ts"
import {
  CommentComposer,
  type CommentDraft,
  CommentsPane,
  discardDraft,
  draftAtSelection,
  highlightsOf,
  selectQuote,
  showHighlights,
} from "./DocumentComments.tsx"

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

type DocumentTarget = { readonly id: string; readonly environment: EnvironmentId }

const storeDataUrl = async ({ id, environment }: DocumentTarget, dataUrl: string) => {
  const { path } = await callPromise("artifacts.addDocumentImage", { id, dataUrl }, { environment })
  return path
}

const storeImage = (target: DocumentTarget) => async (image: File) => storeDataUrl(target, await readAsDataUrl(image))

const imageDataUrl =
  ({ id, environment }: DocumentTarget) =>
  async (path: string) => {
    const { dataUrl } = await callPromise("artifacts.file", { id, path }, { environment })
    return dataUrl
  }

const extensions = (
  placeholder: string,
  theme: CodeTheme,
  target: DocumentTarget,
  openComment: (commentId: string) => void,
) => [
  StarterKit.configure({
    underline: false,
    link: { openOnClick: false },
    codeBlock: false,
    blockquote: false,
  }),
  DocumentBlockquote,
  DocumentCodeBlock,
  DocumentCallout,
  TaskList,
  TaskItem.configure({ nested: true }),
  TableKit.configure({ table: { resizable: false } }),
  DocumentImage.configure({ artifactId: target.id }),
  DocumentPaste.configure({
    artifactId: target.id,
    storeImage: storeImage(target),
    copyImage: async (sourceArtifact, path) =>
      storeDataUrl(target, await imageDataUrl({ id: sourceArtifact, environment: target.environment })(path)),
    imageFailed: (cause) => toast.error(m.documents_image_failed({ message: errorMessage(cause) })),
  }),
  Markdown,
  Placeholder.configure({ placeholder }),
  LinkEditing,
  CodeHighlight.configure({ theme }),
  CommentHighlights.configure({ onOpen: openComment }),
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
  const [comments, setComments] = useState<{ readonly open: boolean; readonly focused: string | null }>({
    open: false,
    focused: null,
  })
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const [, startTransition] = useTransition()
  const editorColumn = useRef<HTMLDivElement>(null)
  const feedback = useFeedback(artifact)
  const actions = useFeedbackActions(artifact)
  const openComment = (focused: string) => startTransition(() => setComments({ open: true, focused }))
  const { codeTheme, scheme } = useTheme(useClientSettings().appearance.theme)
  const [initialTheme] = useState<CodeTheme>({ codeTheme, scheme })
  const [target] = useState<DocumentTarget>({ id: artifact.id, environment: artifact.environmentId ?? null })
  const [sync] = useState(() =>
    createDocumentSync({
      id: target.id,
      environment: target.environment,
      loaded,
      onStatus: setStatus,
    }),
  )
  const editor = useEditor({
    extensions: extensions(m.documents_placeholder(), initialTheme, target, openComment),
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
        html: () => printableHtml(editor.view.dom, imageDataUrl(target)),
        markdown: () => editor.getMarkdown(),
      }),
    [editor, artifact.environmentId, artifact.id, target],
  )

  useEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(codeHighlightKey, { theme: { codeTheme, scheme } }))
  }, [editor, codeTheme, scheme])

  const currentFeedback = loadedFeedback(feedback)
  const highlightsKey = JSON.stringify(highlightsOf(currentFeedback))
  useEffect(() => showHighlights(editor, JSON.parse(highlightsKey)), [editor, highlightsKey])
  const detached = new Set(
    useEditorState({ editor, selector: ({ editor: current }) => commentDetachedIds(current.state) }),
  )
  const openCount = currentFeedback.comments.filter((comment) => !comment.resolved).length

  const startComment = () => {
    const started = draftAtSelection(editor)
    if (started !== null) startTransition(() => setDraft(started))
  }
  const closeDraft = () => {
    discardDraft(editor)
    startTransition(() => setDraft(null))
  }
  const sendComment = async (sent: CommentDraft, body: string) => {
    await actions.comment({ body, anchor: sent.anchor })
    closeDraft()
  }
  const showQuote = (comment: ArtifactComment) => {
    if (editorColumn.current?.checkVisibility() !== true)
      startTransition(() => setComments({ open: false, focused: null }))
    selectQuote(editor, comment)
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col transition-[opacity,translate] duration-200 ease-out starting:opacity-0 motion-safe:starting:translate-x-2">
      <div className="flex min-h-0 flex-1">
        <div ref={editorColumn} className={cn("flex min-w-0 flex-1 flex-col", comments.open && "@max-2xl:hidden")}>
          <DocumentToolbar editor={editor} />
          <SelectionMenu editor={editor} onComment={startComment} />
          <CommentComposer
            editor={editor}
            threadId={threadId}
            draft={draft}
            onSend={sendComment}
            onClose={closeDraft}
          />
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
        </div>
        {comments.open && (
          <CommentsPane
            threadId={threadId}
            feedback={feedback}
            actions={actions}
            detached={detached}
            focused={comments.focused}
            onShowAnchor={showQuote}
            onClose={() => startTransition(() => setComments({ open: false, focused: null }))}
          />
        )}
      </div>
      <DocumentFooter
        threadId={threadId}
        artifact={artifact}
        status={status}
        sync={sync}
        comments={
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={comments.open}
            className="aria-pressed:bg-muted"
            action={() => setComments({ open: !comments.open, focused: null })}
          >
            <FeedbackIcon aria-hidden />
            {m.comments_title()}
            {openCount > 0 && <span className="text-muted-foreground tabular-nums">{openCount}</span>}
          </Button>
        }
      />
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
  comments,
}: {
  threadId: string
  artifact: Artifact
  status: SaveStatus
  sync: DocumentSync
  comments: ReactNode
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
      {comments}
      <Button variant="outline" size="xs" action={askAgent}>
        {m.documents_ask_agent()}
      </Button>
    </div>
  )
}
