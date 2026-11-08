import "./excalidrawAssets.ts"
import { CaptureUpdateAction, Excalidraw, exportToBlob, MainMenu } from "@excalidraw/excalidraw"
import type { ExcalidrawImperativeAPI, UIOptions } from "@excalidraw/excalidraw/types"
import "@excalidraw/excalidraw/index.css"
import { useAtomValue } from "@effect/atom-react"
import { FeedbackIcon } from "@hinacode/icons"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  startTransition,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { toast } from "sonner"
import type { Artifact, ArtifactComment, WhiteboardContent } from "../../../shared/artifact.ts"
import { useTheme } from "../../lib/appearance.ts"
import { readAsDataUrl } from "../../lib/dataUrl.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { call, callPromise, type EnvironmentId, familyOf, onPushEvent } from "../../lib/rpc.ts"
import { useClientSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { getLocale } from "../../paraglide/runtime.js"
import { cn } from "../../lib/utils.ts"
import { CommentsPane } from "../artifactComments/CommentsPane.tsx"
import { loadedFeedback, useFeedback, useFeedbackActions } from "../artifactComments/feedback.ts"
import { Button } from "../ui/button.tsx"
import { Textarea } from "../ui/textarea.tsx"
import { anchorIds, elementsWithLabels } from "./whiteboardScene.ts"
import { createWhiteboardSync, type SaveStatus, type WhiteboardSync } from "./whiteboardSync.ts"

const whiteboardAtom = familyOf((environment: EnvironmentId, id: string) =>
  Atom.make(call("artifacts.readWhiteboard", { id }, { environment })),
)

const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: null },
  tools: { image: false },
}

const EXCALIDRAW_LANGUAGES: Record<string, string> = { ja: "ja-JP", "zh-TW": "zh-TW", "zh-CN": "zh-CN" }

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

const stopHandled = (event: KeyboardEvent) => {
  if (event.defaultPrevented) event.stopPropagation()
}

const keepHandledKeys = (element: HTMLDivElement | null) => {
  element?.addEventListener("keydown", stopHandled)
  return () => element?.removeEventListener("keydown", stopHandled)
}

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((id, index) => id === right[index])

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
  const [selection, setSelection] = useState<ReadonlyArray<string>>([])
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [fitted, setFitted] = useState(false)
  const [comments, setComments] = useState<{ open: boolean; focused: string | null }>({ open: false, focused: null })
  const canvasColumn = useRef<HTMLDivElement>(null)
  const feedback = useFeedback(artifact)
  const actions = useFeedbackActions(artifact)
  const openCount = loadedFeedback(feedback).comments.filter((comment) => !comment.resolved).length
  const { scheme } = useTheme(useClientSettings().appearance.theme)
  const [sync] = useState(() =>
    createWhiteboardSync({
      id: artifact.id,
      environment: artifact.environmentId ?? null,
      loaded,
      onStatus: setStatus,
    }),
  )

  useEffect(() => {
    const stop = onPushEvent((event) => {
      if (event.type === "artifact.updated" && event.artifact.id === artifact.id)
        sync.published(event.artifact.revision)
    })
    return () => {
      stop()
      sync.close()
    }
  }, [artifact.id, sync])

  const showElements = (comment: ArtifactComment) => {
    if (api === null || comment.anchor.kind !== "elements") return
    const ids = new Set(comment.anchor.ids)
    const targets = api.getSceneElements().filter((element) => ids.has(element.id))
    if (targets.length === 0) return
    if (canvasColumn.current?.checkVisibility() !== true)
      startTransition(() => setComments({ open: false, focused: null }))
    api.updateScene({
      appState: { selectedElementIds: Object.fromEntries(targets.map((element) => [element.id, true as const])) },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    api.scrollToContent(targets, { fitToViewport: true, viewportZoomFactor: 0.6, maxZoom: 1, animate: true })
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div
          ref={(element) => {
            canvasColumn.current = element
            return keepHandledKeys(element)
          }}
          className={cn("relative min-h-0 min-w-0 flex-1", comments.open && "@max-2xl:hidden")}
        >
          <div className="absolute inset-0">
            <Excalidraw
              initialData={{ elements: sync.initial.elements, files: sync.initial.files }}
              excalidrawAPI={(created) => {
                sync.attach(created)
                setApi(created)
              }}
              onChange={(elements, appState, files) => {
                if (!fitted && api !== null && appState.width > 0) {
                  api.scrollToContent(elements, {
                    fitToViewport: true,
                    viewportZoomFactor: 0.9,
                    maxZoom: 1,
                    animate: false,
                  })
                  setFitted(true)
                }
                sync.changed(elements, appState, files)
                const selected = Object.keys(appState.selectedElementIds)
                setSelection((current) => (sameIds(current, selected) ? current : selected))
              }}
              theme={scheme}
              langCode={EXCALIDRAW_LANGUAGES[getLocale()] ?? "en"}
              UIOptions={UI_OPTIONS}
              aiEnabled={false}
            >
              <MainMenu>
                <MainMenu.DefaultItems.SearchMenu />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
                <MainMenu.DefaultItems.Help />
              </MainMenu>
            </Excalidraw>
          </div>
        </div>
        {comments.open && (
          <CommentsPane
            threadId={threadId}
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
        api={selection.length === 0 ? null : api}
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

const askAboutSelection = async ({
  threadId,
  artifact,
  sync,
  api,
  body,
}: {
  threadId: string
  artifact: Artifact
  sync: WhiteboardSync
  api: ExcalidrawImperativeAPI
  body: string
}) => {
  const elements = api.getSceneElementsIncludingDeleted()
  const ids = anchorIds(Object.keys(api.getAppState().selectedElementIds), elements)
  if (ids.length === 0) return
  if ((await sync.save()) === null) throw new Error(m.documents_not_saved())
  const image = await exportToBlob({
    elements: elementsWithLabels(ids, elements),
    appState: { ...api.getAppState(), exportBackground: true, exportEmbedScene: false },
    files: api.getFiles(),
    mimeType: "image/png",
    exportPadding: 16,
  })
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

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

const NO_DETACHED: ReadonlySet<string> = new Set()

function WhiteboardFooter({
  threadId,
  artifact,
  status,
  sync,
  api,
  comments,
}: {
  threadId: string
  artifact: Artifact
  status: SaveStatus
  sync: WhiteboardSync
  api: ExcalidrawImperativeAPI | null
  comments: ReactNode
}) {
  const [asking, setAsking] = useState(false)
  const [body, setBody] = useState("")
  const [sending, startSending] = useTransition()
  const text = body.trim()

  const send = async () => {
    if (text === "" || api === null) return
    try {
      await askAboutSelection({ threadId, artifact, sync, api, body: text })
      setAsking(false)
      setBody("")
    } catch (cause) {
      toast.error(m.whiteboard_ask_failed({ message: errorMessage(cause) }))
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
          <Button type="submit" size="xs" disabled={text === "" || api === null || sending}>
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
          disabled={api === null && !asking}
          action={() => setAsking((open) => !open)}
        >
          {asking ? m.common_cancel() : m.whiteboard_ask()}
        </Button>
      </div>
    </div>
  )
}
