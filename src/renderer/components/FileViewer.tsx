import { useAtomRefresh, useAtomSuspense } from "@effect/atom-react"
import { Editor } from "@pierre/diffs/edit"
import { EditProvider, File, type LineAnnotation, Virtualizer } from "@pierre/diffs/react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  type KeyboardEvent,
  type ReactNode,
  Suspense,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react"
import { toast } from "sonner"
import { useTheme } from "../lib/appearance.ts"
import { projectFileUrl } from "../../shared/channels.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { type FilePreview, hasSource, previewOf } from "../lib/filePreview.ts"
import { callPromise, fileContentAtom, onPushEvent, RpcError } from "../lib/rpc.ts"
import { useClientSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { emptyDraft, type LineComment, useDrafts } from "../stores/drafts.ts"
import { emptyTree, parentOf, useExplorer } from "../stores/explorer.ts"
import { FilePath } from "./FilePatch.tsx"
import { LineCommentCard, LineCommentForm } from "./LineComment.tsx"
import { Markdown } from "./Markdown.tsx"
import { Button } from "./ui/button.tsx"
import { CloseIcon } from "./icons/CloseIcon.tsx"
import { CopyIcon } from "./icons/CopyIcon.tsx"
import { FileDiffIcon } from "./icons/FileDiffIcon.tsx"

interface FileViewerProps {
  readonly threadId: string
  readonly root: string
  readonly path: string
  readonly onClose: () => void
  readonly onShowChanges?: () => void
}

const createEditor = <EType extends "file" | "file-diff", LAnnotation, Caret>(
  type: EType,
  options: ConstructorParameters<typeof Editor<EType, LAnnotation, Caret>>[1],
  editStateKey?: string,
) => new Editor<EType, LAnnotation, Caret>(type, options, editStateKey)

export function FileViewer({ threadId, root, path, onClose, onShowChanges }: FileViewerProps) {
  const shownPath = useDeferredValue(path)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    onClose()
    event.stopPropagation()
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape bubbles up from the buttons and the editor.
    <section aria-label={path} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn("flex min-h-0 flex-1 flex-col transition-opacity", shownPath !== path && "opacity-60 delay-150")}
      >
        <FileBody
          key={shownPath}
          threadId={threadId}
          root={root}
          path={shownPath}
          onClose={onClose}
          onShowChanges={shownPath === path ? onShowChanges : undefined}
        />
      </div>
    </section>
  )
}

function FileBody({ threadId, root, path, onClose, onShowChanges }: FileViewerProps) {
  const preview = previewOf(path)
  const [showSource, setShowSource] = useState(false)

  if (preview !== null && !showSource) {
    return (
      <>
        <ViewerHeader path={path} onClose={onClose} onShowChanges={onShowChanges}>
          {hasSource(preview) && (
            <Button variant="ghost" size="xs" onClick={() => setShowSource(true)}>
              {m.viewer_source()}
            </Button>
          )}
        </ViewerHeader>
        {preview === "markdown" ? (
          <Suspense fallback={<Note text={m.viewer_loading()} className="animate-reveal" />}>
            <MarkdownPreview root={root} path={path} />
          </Suspense>
        ) : (
          <FilePreviewPane preview={preview} root={root} path={path} />
        )}
      </>
    )
  }

  const backToPreview = preview !== null && (
    <Button variant="ghost" size="xs" onClick={() => setShowSource(false)}>
      {m.viewer_preview()}
    </Button>
  )
  return (
    <EditProvider createEditor={createEditor}>
      <Suspense
        fallback={
          <>
            <ViewerHeader path={path} onClose={onClose} onShowChanges={onShowChanges} />
            <Note text={m.viewer_loading()} className="animate-reveal" />
          </>
        }
      >
        <FileContent
          threadId={threadId}
          root={root}
          path={path}
          onClose={onClose}
          onShowChanges={onShowChanges}
          headerActions={backToPreview}
        />
      </Suspense>
    </EditProvider>
  )
}

function FilePreviewPane({ preview, root, path }: { preview: FilePreview; root: string; path: string }) {
  const [version, setVersion] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type !== "fs.changed" || event.root !== root || event.path !== parentOf(path)) return
        setVersion((current) => current + 1)
        setFailed(false)
      }),
    [root, path],
  )

  if (failed) return <Note text={m.viewer_preview_failed()} />
  const src = `${projectFileUrl(root, path)}?v=${version}`
  const fail = () => setFailed(true)

  if (preview === "html") {
    return (
      <iframe
        src={src}
        title={path}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    )
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      {preview === "video" ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <video src={src} controls aria-label={path} onError={fail} className="max-h-full max-w-full" />
      ) : preview === "audio" ? (
        // oxlint-disable-next-line jsx-a11y/media-has-caption
        <audio src={src} controls aria-label={path} onError={fail} className="w-full max-w-md" />
      ) : (
        <img
          src={src}
          alt={path}
          onError={fail}
          className="max-h-full max-w-full bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-size-[16px_16px] object-contain"
        />
      )}
    </div>
  )
}

function MarkdownPreview({ root, path }: { root: string; path: string }) {
  const contentAtom = fileContentAtom(JSON.stringify([root, path]))
  const content = useAtomSuspense(contentAtom, { includeFailure: true })
  const reload = useAtomRefresh(contentAtom)

  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type === "fs.changed" && event.root === root && event.path === parentOf(path)) reload()
      }),
    [reload, root, path],
  )

  if (AsyncResult.isFailure(content)) {
    return (
      <p role="alert" className="p-3 text-xs text-destructive">
        {m.viewer_failed({ message: errorMessage(Cause.squash(content.cause)) })}
      </p>
    )
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {content.value.truncated && <Note text={m.viewer_truncated()} />}
      <article className="mx-auto max-w-3xl px-6 py-4">
        <Markdown text={content.value.content} baseUrl={projectFileUrl(root, path)} className="prose-sm" />
      </article>
    </div>
  )
}

interface ViewerHeaderProps {
  readonly path: string
  readonly onClose: () => void
  readonly onShowChanges: (() => void) | undefined
  readonly children?: ReactNode
}

function ViewerHeader({ path, onClose, onShowChanges, children }: ViewerHeaderProps) {
  return (
    <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
      <FilePath path={path} className="flex-1 text-xs" />
      {children}
      {onShowChanges && (
        <Button variant="ghost" size="xs" onClick={onShowChanges}>
          <FileDiffIcon aria-hidden />
          {m.explorer_show_changes()}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={m.explorer_copy_path()}
        title={m.explorer_copy_path()}
        onClick={() => void navigator.clipboard.writeText(path)}
      >
        <CopyIcon aria-hidden />
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label={m.viewer_close()} title={m.viewer_close()} onClick={onClose}>
        <CloseIcon aria-hidden />
      </Button>
    </header>
  )
}

type CommentForm =
  | { readonly kind: "new"; readonly startLine: number; readonly endLine: number }
  | { readonly kind: "edit"; readonly commentId: string }

type Annotation = { readonly kind: "comment"; readonly comment: LineComment } | Extract<CommentForm, { kind: "new" }>

// FIXME: the editor hides ANSI codes but still counts them, so the caret lands off and such a log stays read-only
const isAnsiLog = (path: string, text: string) => path.endsWith(".log") && text.includes("\x1b[")

const linesOf = (text: string, startLine: number, endLine: number) =>
  text
    .split("\n")
    .slice(startLine - 1, endLine)
    .join("\n")

function FileContent({
  threadId,
  root,
  path,
  onClose,
  onShowChanges,
  headerActions,
}: FileViewerProps & { headerActions: ReactNode }) {
  const contentAtom = fileContentAtom(JSON.stringify([root, path]))
  const content = useAtomSuspense(contentAtom, { includeFailure: true })
  const reload = useAtomRefresh(contentAtom)
  const theme = useTheme(useClientSettings().appearance.theme)
  const base = useExplorer((state) => (state.byRoot[root] ?? emptyTree).unsaved[path])
  const setUnsaved = useExplorer((state) => state.setUnsaved)
  const allComments = useDrafts((state) => (state.byThreadId[threadId] ?? emptyDraft).comments)
  const [form, setForm] = useState<CommentForm | null>(null)
  const [saved, setSaved] = useState<{ over: string; text: string } | null>(null)
  const [isSaving, startSaving] = useTransition()
  const editorRef = useRef<Editor<"file", Annotation> | null>(null)

  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type === "fs.changed" && event.root === root && event.path === parentOf(path)) reload()
      }),
    [reload, root, path],
  )

  if (AsyncResult.isFailure(content)) {
    return (
      <>
        <ViewerHeader path={path} onClose={onClose} onShowChanges={onShowChanges}>
          {headerActions}
        </ViewerHeader>
        <p role="alert" className="p-3 text-xs text-destructive">
          {m.viewer_failed({ message: errorMessage(Cause.squash(content.cause)) })}
        </p>
      </>
    )
  }
  const { content: disk, truncated, binary } = content.value
  if (binary) {
    return (
      <>
        <ViewerHeader path={path} onClose={onClose} onShowChanges={onShowChanges}>
          {headerActions}
        </ViewerHeader>
        <Note text={m.viewer_binary()} />
      </>
    )
  }

  const shown = base ?? (saved?.over === disk ? saved.text : disk)
  const ansi = isAnsiLog(path, shown)
  const editable = !truncated && !ansi
  const changedOnDisk = base !== undefined && base !== disk
  const currentText = () => editorRef.current?.getText() ?? shown

  const save = (expected: string | null) => {
    const text = currentText()
    startSaving(async () => {
      try {
        await callPromise("fs.write", { root, path, content: text, expected })
        setSaved({ over: disk, text })
        setUnsaved(root, path, currentText() === text ? null : text)
        reload()
      } catch (cause) {
        if (cause instanceof RpcError && cause.tag === "FsWriteConflict") reload()
        else toast.error(m.viewer_save_failed({ path, message: errorMessage(cause) }))
      }
    })
  }

  const commentOnSelection = () => {
    const [selection] = editorRef.current?.getViewState().selections ?? []
    if (selection) setForm({ kind: "new", startLine: selection.start.line + 1, endLine: selection.end.line + 1 })
  }

  const closeForm = () => {
    setForm(null)
    editorRef.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return
    // FIXME: with Alt held, macOS reports the composed character as `key`
    if (event.altKey && event.code === "KeyC") {
      event.preventDefault()
      commentOnSelection()
    } else if (!event.altKey && event.key === "s") {
      event.preventDefault()
      if (base !== undefined && !changedOnDisk) save(base)
    }
  }

  const comments = allComments.filter((comment) => comment.path === path)
  const annotations: Array<LineAnnotation<Annotation>> = [
    ...comments.map((comment) => ({ lineNumber: comment.endLine, metadata: { kind: "comment" as const, comment } })),
    ...(form?.kind === "new" ? [{ lineNumber: form.endLine, metadata: form }] : []),
  ]

  const renderAnnotation = ({ metadata }: LineAnnotation<Annotation>) => {
    if (metadata.kind === "new") {
      return (
        <LineCommentForm
          path={path}
          startLine={metadata.startLine}
          endLine={metadata.endLine}
          onSubmit={(body) => {
            useDrafts.getState().addComment(threadId, {
              id: crypto.randomUUID(),
              path,
              startLine: metadata.startLine,
              endLine: metadata.endLine,
              code: linesOf(currentText(), metadata.startLine, metadata.endLine),
              body,
            })
            closeForm()
          }}
          onCancel={closeForm}
        />
      )
    }
    const { comment } = metadata
    if (form?.kind === "edit" && form.commentId === comment.id) {
      return (
        <LineCommentForm
          path={path}
          startLine={comment.startLine}
          endLine={comment.endLine}
          initialBody={comment.body}
          onSubmit={(body) => {
            useDrafts.getState().updateComment(threadId, comment.id, body)
            closeForm()
          }}
          onCancel={closeForm}
        />
      )
    }
    return (
      <LineCommentCard
        comment={comment}
        onEdit={() => setForm({ kind: "edit", commentId: comment.id })}
        onDelete={() => useDrafts.getState().removeComment(threadId, comment.id)}
      />
    )
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- mod+s bubbles up from the editor.
    <div onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <ViewerHeader path={path} onClose={onClose} onShowChanges={onShowChanges}>
        {headerActions}
        {base !== undefined && (
          <>
            <span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
              {m.viewer_unsaved()}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={isSaving || changedOnDisk}
              title={m.viewer_save_hint()}
              onClick={() => save(base)}
            >
              {m.viewer_save()}
            </Button>
          </>
        )}
      </ViewerHeader>
      {truncated && <Note text={m.viewer_truncated()} />}
      {changedOnDisk && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
          <span className="min-w-0 flex-1">{m.viewer_changed_on_disk()}</span>
          <Button variant="outline" size="xs" disabled={isSaving} onClick={() => save(null)}>
            {m.viewer_overwrite()}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setUnsaved(root, path, null)}>
            {m.viewer_reload()}
          </Button>
        </div>
      )}
      <Virtualizer className="min-h-0 flex-1 overflow-auto" contentClassName="text-xs">
        <File
          file={{ name: path, contents: shown, lang: ansi ? "ansi" : undefined }}
          edit={editable}
          editStateKey={JSON.stringify([root, path])}
          editorOptions={{
            onAttach: (editor) => {
              editorRef.current = editor
            },
          }}
          onEditChange={(event) => {
            const edited = event.file.contents !== shown
            if (edited !== (base !== undefined)) setUnsaved(root, path, edited ? shown : null)
          }}
          lineAnnotations={annotations}
          selectedLines={form?.kind === "new" ? { start: form.startLine, end: form.endLine } : null}
          renderAnnotation={renderAnnotation}
          options={{
            theme: theme.codeTheme,
            themeType: theme.scheme,
            overflow: "scroll",
            disableFileHeader: true,
            enableGutterUtility: true,
            onGutterUtilityClick: ({ start, end }) => {
              setForm({ kind: "new", startLine: Math.min(start, end), endLine: Math.max(start, end) })
            },
          }}
        />
      </Virtualizer>
    </div>
  )
}

function Note({ text, className }: { text: string; className?: string }) {
  return <p className={cn("shrink-0 px-3 py-2 text-xs text-muted-foreground", className)}>{text}</p>
}
