import { cn } from "cn"
import { type FormEvent, useEffect, useId, useRef, useState } from "react"
import type { BrowserState } from "../../../shared/browser.ts"
import { browserUrl } from "../../lib/browserUrl.ts"
import { elementLabel } from "../../lib/elementPicker.ts"
import { m } from "../../paraglide/messages.js"
import { selectBrowserTabs, useBrowserTabs } from "../../stores/browserTabs.ts"
import { useDrafts } from "../../stores/drafts.ts"
import { useUi } from "../../stores/ui.ts"
import { Button } from "../ui/button.tsx"
import { Input } from "../ui/input.tsx"
import { BrowserStart, type Device, LoadFailure, ViewportMenu } from "./BrowserChrome.tsx"
import { browserPanelId, browserTabId } from "./BrowserTabStrip.tsx"
import { browserViewport, RemoteBrowserSession } from "./remoteBrowserSession.ts"
import { RemoteBrowserSurface } from "./RemoteBrowserSurface.tsx"
import { ArrowLeftIcon } from "../icons/ArrowLeftIcon.tsx"
import { ArrowRightIcon } from "../icons/ArrowRightIcon.tsx"
import { CloseIcon } from "../icons/CloseIcon.tsx"
import { CloudIcon } from "../icons/CloudIcon.tsx"
import { CursorIcon } from "../icons/CursorIcon.tsx"
import { RefreshIcon } from "../icons/RefreshIcon.tsx"

type Connection =
  | { readonly kind: "idle" }
  | { readonly kind: "opening"; readonly url: string }
  | { readonly kind: "ready"; readonly state: BrowserState }
  | { readonly kind: "failed"; readonly url: string; readonly message: string }

interface RemoteBrowserPageProps {
  readonly threadId: string
  readonly tabId: string
  readonly initialUrl: string | null
  readonly active: boolean
}

export function RemoteBrowserPage({ threadId, tabId, initialUrl, active }: RemoteBrowserPageProps) {
  const [startUrl] = useState(initialUrl)
  const [connection, setConnection] = useState<Connection>(() =>
    initialUrl === null ? { kind: "idle" } : { kind: "opening", url: initialUrl },
  )
  const [address, setAddress] = useState(initialUrl ?? "")
  const [invalid, setInvalid] = useState(false)
  const [device, setDevice] = useState<Device | null>(null)
  const [announcement, setAnnouncement] = useState("")
  const sessionRef = useRef<RemoteBrowserSession | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const attachments = useRef(new Set<string>())
  const hintId = useId()
  const focusAddress = useBrowserTabs((state) => state.addressFocusRequest === tabId)

  useEffect(() => {
    const canvas = canvasRef.current
    const viewport = viewportRef.current
    if (!canvas || !viewport) return
    const rect = viewport.getBoundingClientRect()
    const session = new RemoteBrowserSession(threadId, canvas, browserViewport(rect.width, rect.height), {
      onState: (state) => {
        setConnection({ kind: "ready", state })
        if (document.activeElement !== addressRef.current) setAddress(state.url)
        const tab = selectBrowserTabs(threadId)(useBrowserTabs.getState()).tabs.find((each) => each.id === tabId)
        if (tab && (tab.url !== state.url || tab.title !== state.title)) {
          useBrowserTabs.getState().updateTab(threadId, tabId, { url: state.url, title: state.title })
        }
        if (state.pick.kind === "picked" && !attachments.current.has(state.pick.attachment.id)) {
          const attachment = state.pick.attachment
          attachments.current.add(attachment.id)
          useDrafts.getState().addAttachments(threadId, [attachment])
          setAnnouncement(
            m.browser_pick_added({ element: attachment.element ? elementLabel(attachment.element) : attachment.name }),
          )
          useUi.getState().requestComposerFocus()
        }
      },
      onFailure: (url, message) => setConnection({ kind: "failed", url, message }),
    })
    sessionRef.current = session
    if (startUrl !== null) session.navigate(startUrl)
    return () => {
      session.dispose()
      sessionRef.current = null
    }
  }, [threadId, tabId, startUrl])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const resize = () => {
      const rect = viewport.getBoundingClientRect()
      sessionRef.current?.resize(browserViewport(device?.width ?? rect.width, device?.height ?? rect.height))
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    resize()
    return () => observer.disconnect()
  }, [device])

  useEffect(() => {
    const update = () => sessionRef.current?.setVisible(active && document.visibilityState === "visible")
    const release = () => sessionRef.current?.command({ kind: "release" })
    update()
    document.addEventListener("visibilitychange", update)
    window.addEventListener("blur", release)
    return () => {
      document.removeEventListener("visibilitychange", update)
      window.removeEventListener("blur", release)
    }
  }, [active])

  useEffect(() => {
    if (!focusAddress || !active) return
    useBrowserTabs.getState().clearAddressFocusRequest()
    addressRef.current?.focus()
  }, [focusAddress, active])

  const open = (url: string) => {
    setAddress(url)
    setInvalid(false)
    if (connection.kind !== "ready") setConnection({ kind: "opening", url })
    sessionRef.current?.navigate(url)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const url = browserUrl(address)
    setInvalid(url === null)
    if (url) open(url)
  }

  const state = connection.kind === "ready" ? connection.state : null
  const picking = state?.pick.kind === "selecting"
  const loading = connection.kind === "opening" || state?.loading === true
  const failure =
    connection.kind === "failed"
      ? { url: connection.url, description: connection.message }
      : state?.failure
        ? { url: state.url, description: state.failure }
        : null
  const ready = state !== null && failure === null

  const retry = () => {
    if (!failure) return
    setConnection({ kind: "opening", url: failure.url })
    sessionRef.current?.restart(failure.url)
  }

  const togglePick = () => {
    sessionRef.current?.command({ kind: "pick", enabled: !picking })
    if (!picking) inputRef.current?.focus({ preventScroll: true })
  }

  return (
    <div
      id={browserPanelId(threadId, tabId)}
      role="tabpanel"
      aria-labelledby={browserTabId(threadId, tabId)}
      inert={!active}
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
    >
      <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.browser_back()}
          title={m.browser_back()}
          disabled={!state?.back}
          onClick={() => sessionRef.current?.command({ kind: "back" })}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.browser_forward()}
          title={m.browser_forward()}
          disabled={!state?.forward}
          onClick={() => sessionRef.current?.command({ kind: "forward" })}
        >
          <ArrowRightIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={loading ? m.browser_stop() : m.browser_reload()}
          title={loading ? m.browser_stop() : m.browser_reload()}
          disabled={state === null}
          onClick={() => sessionRef.current?.command({ kind: loading ? "stop" : "reload" })}
        >
          {loading ? <CloseIcon aria-hidden /> : <RefreshIcon aria-hidden />}
        </Button>
        <form onSubmit={submit} className="mx-1 min-w-0 flex-1">
          <Input
            ref={addressRef}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value)
              setInvalid(false)
            }}
            onFocus={(event) => event.target.select()}
            aria-label={m.browser_address()}
            aria-invalid={invalid || undefined}
            placeholder={m.browser_address_placeholder()}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-7 font-mono text-xs"
          />
        </form>
        <span
          title={m.browser_remote_description()}
          className="mx-1 inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
        >
          <CloudIcon aria-hidden className="size-3" />
          {m.browser_remote()}
        </span>
        <ViewportMenu device={device} onChange={setDevice} />
        <Button
          variant={picking ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={m.browser_pick()}
          title={picking ? m.browser_pick_cancel() : m.browser_pick()}
          aria-pressed={picking}
          disabled={!ready}
          onClick={togglePick}
          onKeyDown={(event) => {
            if (event.key === "Escape" && picking) {
              event.stopPropagation()
              sessionRef.current?.command({ kind: "pick", enabled: false })
            }
          }}
          className={cn(picking && "text-primary")}
        >
          <CursorIcon aria-hidden />
        </Button>
      </div>
      <div ref={viewportRef} className="relative min-h-0 flex-1">
        <div className={cn("absolute inset-0 flex", device && "overflow-auto bg-muted p-3")}>
          <div
            style={device ? { width: device.width, height: device.height } : undefined}
            className={cn(device ? "m-auto shrink-0 shadow-md" : "min-h-0 min-w-0 flex-1", !ready && "invisible")}
          >
            <RemoteBrowserSurface
              canvasRef={canvasRef}
              inputRef={inputRef}
              addressRef={addressRef}
              sessionRef={sessionRef}
              hintId={hintId}
              picking={picking}
              enabled={ready && active}
            />
          </div>
        </div>
        {connection.kind === "idle" && (
          <BrowserStart threadId={threadId} onOpen={open} hint={m.browser_remote_start_hint()} />
        )}
        {connection.kind === "opening" && (
          <output className="absolute inset-0 flex items-center justify-center bg-background p-6">
            <p className="text-xs text-muted-foreground">{m.browser_remote_connecting()}</p>
          </output>
        )}
        {loading && <div aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
        {failure && <LoadFailure failure={failure} onRetry={retry} />}
        {picking && (
          <output className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
            {m.browser_pick_hint()}
          </output>
        )}
        {state?.pick.kind === "failed" && (
          <p
            role="alert"
            className="absolute inset-x-3 bottom-3 rounded-lg border border-destructive/40 bg-popover px-3 py-2 text-xs text-destructive shadow-md"
          >
            {m.browser_pick_failed({ message: state.pick.message })}
          </p>
        )}
      </div>
      <p id={hintId} className="shrink-0 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
        {m.browser_remote_keyboard_hint()}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
