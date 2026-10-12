import { useAtomRefresh, useAtomSuspense } from "@effect/atom-react"
import { File, Virtualizer } from "@pierre/diffs/react"
import { cn } from "cn"
import { Cause } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type KeyboardEvent, Suspense, useDeferredValue, useEffect } from "react"
import { RiCloseLine, RiFileCopyLine } from "react-icons/ri"
import { useTheme } from "../lib/appearance.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { fileContentAtom, onPushEvent } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { parentOf } from "../stores/explorer.ts"
import { Button } from "./ui/button.tsx"

interface FileViewerProps {
  readonly root: string
  /** Relative to `root`. */
  readonly path: string
  readonly onClose: () => void
}

/** A read-only, highlighted view of one file. */
export function FileViewer({ root, path, onClose }: FileViewerProps) {
  // Switching files keeps the last file on screen until the next one loads.
  const shownPath = useDeferredValue(path)

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return
    onClose()
    // Closing the file must not also close the side panel dialog around it.
    event.stopPropagation()
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape bubbles up from the buttons and the scrolling code.
    <section aria-label={path} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-border pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          {path}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={m.explorer_copy_path()}
          title={m.explorer_copy_path()}
          onClick={() => void navigator.clipboard.writeText(path)}
        >
          <RiFileCopyLine aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={m.viewer_close()} title={m.viewer_close()} onClick={onClose}>
          <RiCloseLine aria-hidden />
        </Button>
      </header>
      <div
        className={cn("flex min-h-0 flex-1 flex-col transition-opacity", shownPath !== path && "opacity-60 delay-150")}
      >
        <Suspense fallback={<Note text={m.viewer_loading()} className="animate-reveal" />}>
          <FileContent key={shownPath} root={root} path={shownPath} />
        </Suspense>
      </div>
    </section>
  )
}

/** Suspends until the file is read, then reloads it in place when its folder changes on disk. */
function FileContent({ root, path }: { root: string; path: string }) {
  const contentAtom = fileContentAtom(JSON.stringify([root, path]))
  const content = useAtomSuspense(contentAtom, { includeFailure: true })
  const reload = useAtomRefresh(contentAtom)
  const theme = useTheme(useSettings().appearance.theme)

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
  const { content: contents, truncated, binary } = content.value
  if (binary) return <Note text={m.viewer_binary()} />
  return (
    <>
      {truncated && <Note text={m.viewer_truncated()} />}
      <Virtualizer className="min-h-0 flex-1 overflow-auto" contentClassName="text-xs">
        <File
          file={{ name: path, contents }}
          options={{
            theme: theme.codeTheme,
            themeType: theme.scheme,
            overflow: "scroll",
            disableFileHeader: true,
          }}
        />
      </Virtualizer>
    </>
  )
}

function Note({ text, className }: { text: string; className?: string }) {
  return <p className={cn("shrink-0 px-3 py-2 text-xs text-muted-foreground", className)}>{text}</p>
}
