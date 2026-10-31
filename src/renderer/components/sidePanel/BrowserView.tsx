import { cn } from "cn"
import { Schema } from "effect"
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react"
import type { Thread } from "../../../shared/domain.ts"
import { browserUrl } from "../../lib/browserUrl.ts"
import { useThreadEnvironment } from "../../lib/environments.ts"
import {
  attachPick,
  CANCEL_PICK_SCRIPT,
  elementLabel,
  PagePick,
  PICK_ELEMENT_SCRIPT,
  type WebviewElement,
} from "../../lib/elementPicker.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { m } from "../../paraglide/messages.js"
import { selectBrowserTabs, useBrowserTabs } from "../../stores/browserTabs.ts"
import { useUi } from "../../stores/ui.ts"
import { Button } from "../ui/button.tsx"
import { Input } from "../ui/input.tsx"
import { BrowserStart, type Device, type Failure, LoadFailure, ViewportMenu } from "./BrowserChrome.tsx"
import { browserPanelId, browserTabId } from "./BrowserTabStrip.tsx"
import { RemoteBrowserPage } from "./RemoteBrowserPage.tsx"
import { ArrowLeftIcon } from "../icons/ArrowLeftIcon.tsx"
import { ArrowRightIcon } from "../icons/ArrowRightIcon.tsx"
import { CloseIcon } from "../icons/CloseIcon.tsx"
import { CursorIcon } from "../icons/CursorIcon.tsx"
import { RefreshIcon } from "../icons/RefreshIcon.tsx"

const ALLOW_POPUPS: Record<string, string> = { allowpopups: "" }

const ERR_ABORTED = -3

type NavigationEvent = Event & { url: string; isMainFrame?: boolean; isInPlace?: boolean }
type TitleEvent = Event & { title: string }
type FailLoadEvent = Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }

export function BrowserView({ thread }: { thread: Thread }) {
  const { tabs, activeId } = useBrowserTabs(selectBrowserTabs(thread.id))
  const remote = useThreadEnvironment(thread.id) !== null
  const Page = remote ? RemoteBrowserPage : BrowserPage

  useEffect(() => {
    useUi.getState().setSidePanelWide(true)
    return () => useUi.getState().setSidePanelWide(false)
  }, [])

  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => (
        <Page key={tab.id} threadId={thread.id} tabId={tab.id} initialUrl={tab.url} active={tab.id === activeId} />
      ))}
    </div>
  )
}

interface BrowserPageProps {
  readonly threadId: string
  readonly tabId: string
  readonly initialUrl: string | null
  readonly active: boolean
}

function BrowserPage({ threadId, tabId, initialUrl, active }: BrowserPageProps) {
  const [src, setSrc] = useState(initialUrl)
  const [address, setAddress] = useState(src ?? "")
  const [invalid, setInvalid] = useState(false)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState({ back: false, forward: false })
  const [failure, setFailure] = useState<Failure | null>(null)
  const [picking, setPicking] = useState(false)
  const [announcement, setAnnouncement] = useState("")
  const [pickError, setPickError] = useState<string | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const viewRef = useRef<WebviewElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const pick = useRef<AbortController | null>(null)
  const focusAddress = useBrowserTabs((state) => state.addressFocusRequest === tabId)

  useEffect(() => {
    if (!focusAddress) return
    useBrowserTabs.getState().clearAddressFocusRequest()
    addressRef.current?.focus()
  }, [focusAddress])

  const endPick = () => {
    pick.current?.abort()
    pick.current = null
    setPicking(false)
  }

  useEffect(() => {
    if (active || !pick.current) return
    viewRef.current?.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {})
  }, [active])

  const attachView = (view: WebviewElement | null) => {
    if (!view) return
    viewRef.current = view
    const syncHistory = () => setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
    const arrived = (url: string) => {
      setFailure(null)
      setPickError(null)
      if (document.activeElement !== addressRef.current) setAddress(url)
      useBrowserTabs.getState().updateTab(threadId, tabId, { url })
      syncHistory()
    }
    const listeners: Record<string, (event: never) => void> = {
      "did-start-loading": () => setLoading(true),
      "did-stop-loading": () => {
        setLoading(false)
        syncHistory()
      },
      "did-start-navigation": (event: NavigationEvent) => {
        if (event.isMainFrame && !event.isInPlace) endPick()
      },
      "did-navigate": (event: NavigationEvent) => arrived(event.url),
      "did-navigate-in-page": (event: NavigationEvent) => {
        if (event.isMainFrame) arrived(event.url)
      },
      "page-title-updated": (event: TitleEvent) =>
        useBrowserTabs.getState().updateTab(threadId, tabId, { title: event.title }),
      "did-fail-load": (event: FailLoadEvent) => {
        if (!event.isMainFrame || event.errorCode === ERR_ABORTED) return
        setFailure({ url: event.validatedURL, description: event.errorDescription })
        setAddress(event.validatedURL)
      },
    }
    for (const [type, listener] of Object.entries(listeners)) view.addEventListener(type, listener as EventListener)
    return () => {
      for (const [type, listener] of Object.entries(listeners)) {
        view.removeEventListener(type, listener as EventListener)
      }
      viewRef.current = null
    }
  }

  const open = (url: string) => {
    setAddress(url)
    setFailure(null)
    if (viewRef.current) viewRef.current.loadURL(url).catch(() => {})
    else setSrc(url)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const url = browserUrl(address)
    setInvalid(url === null)
    if (url) open(url)
  }

  const startPick = async () => {
    const view = viewRef.current
    if (!view) return
    pick.current?.abort()
    const controller = new AbortController()
    pick.current = controller
    setPicking(true)
    setPickError(null)
    view.focus()
    try {
      const result = await view.executeJavaScript(PICK_ELEMENT_SCRIPT)
      controller.signal.throwIfAborted()
      if (result !== null) {
        const decoded = Schema.decodeUnknownSync(PagePick)(result)
        const attachment = await attachPick(threadId, view, decoded, controller.signal)
        setAnnouncement(m.browser_pick_added({ element: elementLabel(attachment.element) }))
        useUi.getState().requestComposerFocus()
      }
    } catch (cause) {
      if (!controller.signal.aborted) setPickError(m.browser_pick_failed({ message: errorMessage(cause) }))
    }
    if (pick.current === controller) endPick()
  }

  const stopPick = () => {
    endPick()
    viewRef.current?.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {})
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !picking) return
    event.stopPropagation()
    stopPick()
  }

  const ready = src !== null

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
          disabled={!history.back}
          onClick={() => viewRef.current?.goBack()}
        >
          <ArrowLeftIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.browser_forward()}
          title={m.browser_forward()}
          disabled={!history.forward}
          onClick={() => viewRef.current?.goForward()}
        >
          <ArrowRightIcon aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={loading ? m.browser_stop() : m.browser_reload()}
          title={loading ? m.browser_stop() : m.browser_reload()}
          disabled={!ready}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
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
        <ViewportMenu device={device} onChange={setDevice} />
        <Button
          variant={picking ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={m.browser_pick()}
          title={picking ? m.browser_pick_cancel() : m.browser_pick()}
          aria-pressed={picking}
          onKeyDown={onKeyDown}
          disabled={!ready || failure !== null}
          onClick={() => (picking ? stopPick() : void startPick())}
          className={cn(picking && "text-primary")}
        >
          <CursorIcon aria-hidden />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {src === null ? (
          <BrowserStart threadId={threadId} onOpen={open} />
        ) : (
          <div className={cn("absolute inset-0 flex", device && "overflow-auto bg-muted p-3")}>
            <webview
              ref={attachView}
              {...ALLOW_POPUPS}
              src={src}
              title={m.browser_page()}
              style={device ? { width: device.width, height: device.height } : undefined}
              className={cn(
                "flex",
                device ? "m-auto max-h-full shrink-0 bg-background shadow-md" : "flex-1",
                failure && "invisible",
              )}
            />
          </div>
        )}
        {loading && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary motion-reduce:animate-none"
          />
        )}
        {failure && <LoadFailure failure={failure} onRetry={() => open(failure.url)} />}
        {picking && (
          <output className="pointer-events-none absolute inset-x-3 bottom-3 animate-fade-in rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md motion-reduce:animate-none">
            {m.browser_pick_hint()}
          </output>
        )}
        {pickError && !picking && (
          <p
            role="alert"
            className="absolute inset-x-3 bottom-3 rounded-lg border border-destructive/40 bg-popover px-3 py-2 text-xs text-destructive shadow-md"
          >
            {pickError}
          </p>
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}
