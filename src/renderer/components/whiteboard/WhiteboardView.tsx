import { useAtomValue } from "@effect/atom-react"
import { FeedbackIcon } from "@hinacode/icons"
import { AsyncResult, Atom } from "effect/reactivity"
import { type ReactNode, startTransition, useEffect, useRef, useState, useTransition } from "react"
import { toast } from "sonner"
import type { Artifact, ArtifactComment, WhiteboardContent } from "../../../shared/artifact.ts"
import { readAsDataUrl } from "../../lib/dataUrl.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { call, callPromise, type EnvironmentId, familyOf, onPushEvent } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { cn } from "../../lib/utils.ts"
import { CommentsPane } from "../artifactComments/CommentsPane.tsx"
import { loadedFeedback, useFeedback, useFeedbackActions } from "../artifactComments/feedback.ts"
import { Button } from "../ui/button.tsx"
import { Textarea } from "../ui/textarea.tsx"
import { OwnCanvas, type FocusRequest, type Tool } from "./OwnCanvas.tsx"
import type { OwnElement } from "./own/elements.ts"
import { exportElementsPng, type ExportTheme } from "./own/export.ts"
import { createWhiteboardSync, initialElements, type SaveStatus, type WhiteboardSync } from "./own/sync.ts"
import { anchorIds } from "./whiteboardScene.ts"

const whiteboardAtom = familyOf((environment: EnvironmentId, id: string) =>
  Atom.make(call("artifacts.readWhiteboard", { id }, { environment })),
)

const loadFailed = (message: string) => (
  <p role="alert" className="p-4 text-xs wrap-anywhere text-destructive">
    {m.whiteboard_load_failed({ message })}
  </p>
)

export function WhiteboardView({ threadId, artifact }: { threadId: string; artifact: Artifact }) {
  const content = useAtomValue(whiteboardAtom(artifact.environmentId ?? null, artifact.id))
  return AsyncResult.builder(content)
    .onInitial(() => <p className="animate-reveal p-4 text-xs text-muted-foreground">{m.whiteboard_loading()}</p>)
    .onSuccess((loaded) => <WhiteboardCanvas threadId={threadId} artifact={artifact} loaded={loaded} />)
    .onError((error) => loadFailed(errorMessage(error)))
    .orElse(() => loadFailed(""))
}

const exportTheme = (): ExportTheme => {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    background: read("--background", "#ffffff"),
    foreground: read("--foreground", "#111111"),
    muted: read("--muted", "#eeeeee"),
    mutedForeground: read("--muted-foreground", "#666666"),
  }
}

const askAboutSelection = async ({
  threadId,
  artifact,
  sync,
  elements,
  selection,
  body,
}: {
  threadId: string
  artifact: Artifact
  sync: WhiteboardSync
  elements: ReadonlyArray<OwnElement>
  selection: ReadonlyArray<string>
  body: string
}) => {
  const ids = anchorIds([...selection], elements)
  if (ids.length === 0) return
  if ((await sync.save()) === null) throw new Error(m.documents_not_saved())
  const image = await exportElementsPng(elements, ids, exportTheme())
  const attachment = await callPromise("attachments.stage", {
    threadId: artifact.threadId ?? threadId,
    source: {
      dataUrl: await readAsDataUrl(new File([image], "selection.png", { type: "image/png" })),
      name: `${artifact.title}.png`,
    },
  })
  await callPromise(
    "artifacts.comment",
    { id: artifact.id, anchor: { kind: "elements", ids }, body, attachments: [attachment] },
    { environment: artifact.environmentId },
  )
}

function WhiteboardCanvas({
  threadId,
  artifact,
  loaded,
}: {
  threadId: string
  artifact: Artifact
  loaded: WhiteboardContent
}) {
  const [status, setStatus] = useState<SaveStatus>({ type: "saved" })
  const [elements, setElements] = useState<OwnElement[]>(() =>
    initialElements(artifact.environmentId ?? null, artifact.id, loaded),
  )
  const [sync] = useState(() =>
    createWhiteboardSync({
      id: artifact.id,
      environment: artifact.environmentId ?? null,
      loaded,
      onStatus: setStatus,
      onElements: setElements,
    }),
  )
  const [selection, setSelection] = useState<string[]>([])
  const [tool, setTool] = useState<Tool>("select")
  const [focus, setFocus] = useState<FocusRequest | null>(null)
  const [comments, setComments] = useState<{ open: boolean; focused: string | null }>({ open: false, focused: null })
  const canvasColumn = useRef<HTMLDivElement>(null)
  const focusNonce = useRef(0)
  const feedback = useFeedback(artifact)
  const actions = useFeedbackActions(artifact)
  const openCount = loadedFeedback(feedback).comments.filter((comment) => !comment.resolved).length

  useEffect(() => {
    sync.open()
    const stop = onPushEvent((event) => {
      if (event.type === "artifact.updated" && event.artifact.id === artifact.id)
        sync.published(event.artifact.revision)
    })
    return () => {
      stop()
      sync.close()
    }
  }, [artifact.id, sync])

  const change = (next: OwnElement[]) => {
    setElements(next)
    sync.changed(next)
  }

  const showElements = (comment: ArtifactComment) => {
    if (comment.anchor.kind !== "elements") return
    focusNonce.current += 1
    setFocus({ ids: comment.anchor.ids, nonce: focusNonce.current })
    if (canvasColumn.current?.checkVisibility() !== true)
      startTransition(() => setComments({ open: false, focused: null }))
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div ref={canvasColumn} className={cn("relative min-h-0 min-w-0 flex-1", comments.open && "@max-2xl:hidden")}>
          <OwnCanvas
            elements={elements}
            selection={selection}
            tool={tool}
            onToolChange={setTool}
            onChange={change}
            onSelectionChange={setSelection}
            focus={focus}
          />
        </div>
        {comments.open && (
          <CommentsPane
            threadId={artifact.threadId ?? threadId}
            feedback={feedback}
            actions={actions}
            detached={NO_DETACHED}
            focused={comments.focused}
            onShowAnchor={showElements}
            onClose={() => startTransition(() => setComments({ open: false, focused: null }))}
          />
        )}
      </div>
      <WhiteboardFooter
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
        threadId={threadId}
        artifact={artifact}
        status={status}
        sync={sync}
        elements={elements}
        selection={selection}
      />
    </div>
  )
}

const statusText = (status: SaveStatus) => {
  switch (status.type) {
    case "saved":
      return m.documents_saved()
    case "dirty":
    case "saving":
    case "conflict":
      return m.documents_saving()
    case "failed":
      return m.documents_save_failed({ message: status.message })
  }
}

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

const NO_DETACHED: ReadonlySet<string> = new Set()

function WhiteboardFooter({
  threadId,
  artifact,
  status,
  sync,
  elements,
  selection,
  comments,
}: {
  threadId: string
  artifact: Artifact
  status: SaveStatus
  sync: WhiteboardSync
  elements: ReadonlyArray<OwnElement>
  selection: ReadonlyArray<string>
  comments: ReactNode
}) {
  const [asking, setAsking] = useState(false)
  const [body, setBody] = useState("")
  const [sending, startSending] = useTransition()
  const text = body.trim()
  const canAsk = selection.length > 0

  const send = async () => {
    if (text === "") return
    try {
      await askAboutSelection({ threadId, artifact, sync, elements, selection, body: text })
      setAsking(false)
      setBody("")
    } catch (cause) {
      toast.error(m.whiteboard_ask_failed({ message: errorMessage(cause) }))
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      setAsking(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-1.5">
      {asking && (
        <form
          className="flex items-end gap-2 pt-1.5"
          onSubmit={(event) => {
            event.preventDefault()
            if (!sending) startSending(send)
          }}
        >
          <Textarea
            ref={focusOnMount}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={onKeyDown}
            readOnly={sending}
            aria-label={m.whiteboard_ask_label()}
            placeholder={m.whiteboard_ask_label()}
            className="max-h-32 min-h-9 flex-1 resize-none text-xs"
          />
          <Button type="submit" size="xs" disabled={text === "" || !canAsk || sending}>
            {m.whiteboard_ask_send()}
          </Button>
        </form>
      )}
      <div className="flex items-center gap-2">
        <p
          className={`min-w-0 flex-1 truncate text-xs ${status.type === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {status.type === "failed" ? <span role="alert">{statusText(status)}</span> : statusText(status)}
        </p>
        {status.type === "failed" && (
          <Button
            variant="outline"
            size="xs"
            action={async () => {
              await sync.save()
            }}
          >
            {m.sidebar_retry()}
          </Button>
        )}
        {comments}
        <Button
          variant={asking ? "ghost" : "outline"}
          size="xs"
          disabled={!canAsk && !asking}
          action={() => setAsking((open) => !open)}
        >
          {asking ? m.common_cancel() : m.whiteboard_ask()}
        </Button>
      </div>
    </div>
  )
}
