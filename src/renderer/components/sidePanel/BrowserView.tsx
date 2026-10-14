import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCloseLine,
  RiCursorLine,
  RiErrorWarningLine,
  RiGlobalLine,
  RiRefreshLine,
} from "react-icons/ri"
import type { Thread } from "../../../shared/domain.ts"
import { browserUrl } from "../../lib/browserUrl.ts"
import {
  attachPick,
  CANCEL_PICK_SCRIPT,
  elementLabel,
  PagePick,
  PICK_ELEMENT_SCRIPT,
  type WebviewElement,
} from "../../lib/elementPicker.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { threadPortsAtom } from "../../lib/rpc.ts"
import { m } from "../../paraglide/messages.js"
import { selectBrowserTabs, useBrowserTabs } from "../../stores/browserTabs.ts"
import { useUi } from "../../stores/ui.ts"
import { Button } from "../ui/button.tsx"
import { Input } from "../ui/input.tsx"
import { browserPanelId, browserTabId } from "./BrowserTabStrip.tsx"

/**
 * Without `allowpopups` the page's `window.open` and `target=_blank` links do nothing; with it, main loads them in
 * place. React drops `true` on an attribute it does not know, and Electron only checks that it is present.
 */
const ALLOW_POPUPS: Record<string, string> = { allowpopups: "" }

/** Chromium's code for a navigation that was replaced or stopped, which is not a failure to show. */
const ERR_ABORTED = -3

type NavigationEvent = Event & { url: string; isMainFrame?: boolean; isInPlace?: boolean }
type TitleEvent = Event & { title: string }
type FailLoadEvent = Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean }

interface Failure {
  readonly url: string
  readonly description: string
}

/** Browser tabs for the thread's dev servers, whose elements can be picked into the message. */
export function BrowserView({ thread }: { thread: Thread }) {
  const { tabs, activeId } = useBrowserTabs(selectBrowserTabs(thread.id))

  // A page needs the room an editor gets.
  useEffect(() => {
    useUi.getState().setSidePanelWide(true)
    return () => useUi.getState().setSidePanelWide(false)
  }, [])

  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => (
        <BrowserPage
          key={tab.id}
          threadId={thread.id}
          tabId={tab.id}
          initialUrl={tab.url}
          active={tab.id === activeId}
        />
      ))}
    </div>
  )
}

interface BrowserPageProps {
  readonly threadId: string
  readonly tabId: string
  /** Where the page starts. After that the page navigates on its own and reports back through the store. */
  readonly initialUrl: string | null
  /** Hidden tabs stay mounted, so their pages keep running and come back without a reload. */
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
  const viewRef = useRef<WebviewElement | null>(null)
  const addressRef = useRef<HTMLInputElement | null>(null)
  const pick = useRef<AbortController | null>(null)
  const focusAddress = useBrowserTabs((state) => state.addressFocusRequest === tabId)

  useEffect(() => {
    if (!focusAddress) return
    useBrowserTabs.getState().clearAddressFocusRequest()
    addressRef.current?.focus()
  }, [focusAddress])

  const endPick = useCallback(() => {
    pick.current?.abort()
    pick.current = null
    setPicking(false)
  }, [])

  // The cancelled pick resolves null, and `startPick` ends it like an Escape.
  useEffect(() => {
    if (active || !pick.current) return
    viewRef.current?.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {})
  }, [active])

  const attachView = useCallback(
    (view: WebviewElement | null) => {
      if (!view) return
      viewRef.current = view
      const syncHistory = () => setHistory({ back: view.canGoBack(), forward: view.canGoForward() })
      const arrived = (url: string) => {
        setFailure(null)
        setPickError(null)
        // A client-side route change or hot reload must not wipe what the user is typing.
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
    },
    [threadId, tabId, endPick],
  )

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
      if (result === null) return
      const decoded = Schema.decodeUnknownSync(PagePick)(result)
      const attachment = await attachPick(threadId, view, decoded, controller.signal)
      setAnnouncement(m.browser_pick_added({ element: elementLabel(attachment.element) }))
      useUi.getState().requestComposerFocus()
    } catch (cause) {
      if (!controller.signal.aborted) setPickError(m.browser_pick_failed({ message: errorMessage(cause) }))
    } finally {
      if (pick.current === controller) endPick()
    }
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
          <RiArrowLeftLine aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.browser_forward()}
          title={m.browser_forward()}
          disabled={!history.forward}
          onClick={() => viewRef.current?.goForward()}
        >
          <RiArrowRightLine aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={loading ? m.browser_stop() : m.browser_reload()}
          title={loading ? m.browser_stop() : m.browser_reload()}
          disabled={!ready}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
        >
          {loading ? <RiCloseLine aria-hidden /> : <RiRefreshLine aria-hidden />}
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
            className="h-7 font-mono text-xs md:text-xs"
          />
        </form>
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
          <RiCursorLine aria-hidden />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {src === null ? (
          <BrowserStart threadId={threadId} onOpen={open} />
        ) : (
          <webview
            ref={attachView}
            {...ALLOW_POPUPS}
            src={src}
            title={m.browser_page()}
            className={cn("absolute inset-0 flex", failure && "invisible")}
          />
        )}
        {loading && (
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary motion-reduce:animate-none"
          />
        )}
        {failure && <LoadFailure failure={failure} onRetry={() => open(failure.url)} />}
        {picking && (
          <output className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md animate-fade-in motion-reduce:animate-none">
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

/** Before any page is open: the ports the thread's processes listen on, one click each. */
function BrowserStart({ threadId, onOpen }: { threadId: string; onOpen: (url: string) => void }) {
  const ports = AsyncResult.getOrElse(useAtomValue(threadPortsAtom(threadId)), () => [])
  const unique = [...new Map(ports.map((port) => [port.port, port])).values()]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <RiGlobalLine aria-hidden className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{m.browser_start_title()}</h3>
        <p className="max-w-64 text-xs text-pretty text-muted-foreground">{m.browser_start_hint()}</p>
      </div>
      {unique.length > 0 && (
        <ul className="flex w-full max-w-72 flex-col gap-1">
          {unique.map((port) => (
            <li key={port.port}>
              <Button
                variant="outline"
                size="sm"
                aria-label={m.browser_start_open_port({ port: String(port.port) })}
                onClick={() => onOpen(`http://localhost:${port.port}/`)}
                className="w-full justify-between font-normal"
              >
                <span className="font-mono">localhost:{port.port}</span>
                <span className="truncate text-muted-foreground">{port.command}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LoadFailure({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center"
    >
      <RiErrorWarningLine aria-hidden className="size-6 text-muted-foreground" />
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium break-all">{m.browser_load_failed({ url: failure.url })}</p>
        <p className="font-mono text-xs text-muted-foreground">{failure.description}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {m.sidebar_retry()}
      </Button>
    </div>
  )
}
