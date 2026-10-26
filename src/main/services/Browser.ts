import { randomUUID } from "node:crypto"
import { access, constants } from "node:fs/promises"
import { join } from "node:path"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import {
  chromium,
  errors,
  type Browser as ChromiumBrowser,
  type BrowserContext,
  type CDPSession,
  type Dialog,
  type Download,
  type FileChooser,
  type Frame,
  type Page,
  type Request,
} from "playwright"
import { RpcMethods, type RpcRequest } from "../../shared/contract.ts"
import {
  BrowserFrame,
  PagePick,
  type BrowserCommand,
  type BrowserSnapshot,
  type BrowserState,
} from "../../shared/browser.ts"
import { CANCEL_PICK_SCRIPT, PICK_ELEMENT_SCRIPT } from "../../shared/browserPicker.ts"
import { Attachments } from "./Attachments.ts"
import { makeActiveWorkspace } from "./workspace.ts"

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", { message: Schema.String }) {}

export class Browser extends Context.Service<
  Browser,
  {
    readonly open: (input: RpcRequest<"browser.open">) => Effect.Effect<{ sessionId: string }, BrowserError>
    readonly command: (input: RpcRequest<"browser.command">) => Effect.Effect<void, BrowserError>
    readonly frame: (input: RpcRequest<"browser.frame">) => Effect.Effect<BrowserSnapshot, BrowserError>
    readonly close: (input: RpcRequest<"browser.close">) => Effect.Effect<void, BrowserError>
  }
>()("hinacode/Browser") {}

interface ThreadContext {
  readonly context: Promise<BrowserContext>
  users: number
}

interface Live {
  readonly id: string
  readonly threadId: string
  readonly owner: ThreadContext
  page: Page
  cdp: CDPSession
  detachPage: () => Promise<void>
  adoption: Promise<void> | null
  readonly keys: Map<string, Extract<BrowserCommand, { kind: "key" }>>
  readonly buttons: Set<"left" | "middle" | "right">
  state: BrowserState
  viewport: { width: number; height: number }
  latest: typeof BrowserFrame.Type | null
  sequence: number
  lease: number
  casting: boolean
  closed: boolean
  pickEpoch: number
  navigationEpoch: number
  pointer: { x: number; y: number }
  input: Promise<void>
}

export interface BrowserOptions {
  readonly executablePath?: string
  readonly leaseMs?: number
  readonly sweepMs?: number
}

const MAX_FRAME_LENGTH = 4 * 1024 * 1024
const META_EDIT_COMMANDS: Readonly<Record<string, string>> = {
  KeyA: "selectAll",
  KeyZ: "undo",
  "Shift+KeyZ": "redo",
}
const ScreencastAck = Schema.Struct({ sessionId: Schema.Int })
const ScreencastFrame = Schema.Struct({
  ...ScreencastAck.fields,
  data: Schema.String.check(Schema.isMaxLength(MAX_FRAME_LENGTH)),
  metadata: Schema.Struct({ deviceWidth: Schema.Int, deviceHeight: Schema.Int }),
})

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const failure = (cause: unknown) => new BrowserError({ message: messageOf(cause) })
const isWebUrl = (value: string) => {
  const url = URL.parse(value)
  return url !== null && (url.protocol === "http:" || url.protocol === "https:")
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const executablePath = async (override: string | undefined) => {
  if (override) return override
  const paths: Partial<Record<NodeJS.Platform, ReadonlyArray<string>>> = {
    linux: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    win32: [
      join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      join(
        process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
      join(process.env["LOCALAPPDATA"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    ],
  }
  const candidates = paths[process.platform] ?? []
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

const make = (options: BrowserOptions) =>
  Effect.gen(function* () {
    const activeWorkspace = yield* makeActiveWorkspace
    const attachments = yield* Attachments
    const scope = yield* Effect.scope
    const sessions = new Map<string, Live>()
    const contexts = new Map<string, ThreadContext>()
    let processPromise: Promise<ChromiumBrowser> | null = null
    let disposed = false

    const launch = () => {
      if (disposed) return Promise.reject(new BrowserError({ message: "Browser service has stopped" }))
      if (processPromise) return processPromise
      const pending = (async () => {
        const path = await executablePath(options.executablePath ?? process.env["HINACODE_BROWSER_EXECUTABLE_PATH"])
        try {
          return await chromium.launch({
            executablePath: path,
            headless: true,
            chromiumSandbox: true,
            args: ["--deny-permission-prompts", "--disable-dev-shm-usage"],
          })
        } catch (cause) {
          throw new BrowserError({
            message: `Could not start a browser on this machine. Install Chromium with \`npx playwright install chromium\` on the host, or set HINACODE_BROWSER_EXECUTABLE_PATH. The host must allow Chromium's sandbox. ${messageOf(cause)}`,
          })
        }
      })()
      processPromise = pending
      void pending.catch(() => {
        if (processPromise === pending) processPromise = null
      })
      return pending
    }

    const recordFailure = (live: Live, cause: unknown) => {
      if (!live.closed) live.state = { ...live.state, failure: messageOf(cause), loading: false }
    }

    const run = (work: () => Promise<unknown>, onError: (cause: unknown) => void) =>
      Effect.runFork(Effect.tryPromise({ try: work, catch: onError }).pipe(Effect.ignore, Effect.forkIn(scope)))

    const retainContext = (threadId: string) => {
      const existing = contexts.get(threadId)
      if (existing) {
        existing.users += 1
        return existing
      }
      const owner: ThreadContext = {
        users: 1,
        context: launch().then(async (browser) => {
          const context = await browser.newContext({
            acceptDownloads: false,
            serviceWorkers: "block",
            viewport: { width: 1280, height: 800 },
          })
          context.setDefaultTimeout(5000)
          context.setDefaultNavigationTimeout(30000)
          await context.route("**/*", async (route) => {
            const request = route.request()
            if (request.isNavigationRequest() && !isWebUrl(request.url())) {
              await route.abort("blockedbyclient")
              return
            }
            await route.continue()
          })
          return context
        }),
      }
      contexts.set(threadId, owner)
      return owner
    }

    const releaseContext = async (threadId: string, owner: ThreadContext) => {
      owner.users -= 1
      if (owner.users > 0) return
      if (contexts.get(threadId) === owner) contexts.delete(threadId)
      const context = await owner.context.catch(() => null)
      await context?.close()
      if (contexts.size === 0 && processPromise !== null) {
        const pending = processPromise
        processPromise = null
        const browser = await pending.catch(() => null)
        await browser?.close()
      }
    }

    const queueInput = (live: Live, work: () => Promise<unknown>) => {
      const next = live.input.then(async () => {
        await work()
      })
      live.input = next.catch(() => undefined)
      return next
    }

    const releaseInput = (live: Live) => {
      const cdp = live.cdp
      return queueInput(live, async () => {
        for (const key of live.keys.values()) {
          await cdp.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: key.key,
            code: key.code,
            windowsVirtualKeyCode: key.keyCode,
            modifiers: 0,
          })
        }
        live.keys.clear()
        for (const button of live.buttons) {
          await cdp.send("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            ...live.pointer,
            button,
            buttons: 0,
          })
        }
        live.buttons.clear()
      })
    }

    const cancelPick = async (live: Live) => {
      const page = live.page
      live.pickEpoch += 1
      live.state = { ...live.state, pick: { kind: "idle" } }
      try {
        await page.evaluate(CANCEL_PICK_SCRIPT)
      } catch (cause) {
        if (live.page === page && !live.closed && !live.state.loading) recordFailure(live, cause)
      }
    }

    const closeLive = async (live: Live) => {
      if (live.closed) return
      live.closed = true
      live.pickEpoch += 1
      sessions.delete(live.id)
      try {
        if (!live.page.isClosed()) await releaseInput(live)
      } finally {
        await live
          .detachPage()
          .finally(() =>
            live.page.close({ runBeforeUnload: false }).finally(() => releaseContext(live.threadId, live.owner)),
          )
      }
    }

    const casting = async (live: Live, enabled: boolean) => {
      const cdp = live.cdp
      if (live.casting === enabled) return
      live.casting = enabled
      try {
        if (enabled) {
          await cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: 70,
            maxWidth: live.viewport.width,
            maxHeight: live.viewport.height,
            everyNthFrame: 1,
          })
        } else {
          await cdp.send("Page.stopScreencast")
          if (live.cdp === cdp) live.latest = null
        }
      } catch (cause) {
        if (live.cdp === cdp) live.casting = !enabled
        throw cause
      }
    }

    const capture = async (live: Live) => {
      const page = live.page
      const viewport = live.viewport
      const image = await page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 })
      if (live.page !== page || live.closed) return
      const jpeg = image.toString("base64")
      if (jpeg.length > MAX_FRAME_LENGTH) throw new BrowserError({ message: "Browser frame is too large" })
      live.latest = { jpeg, sequence: ++live.sequence, ...viewport }
    }

    const metadata = async (live: Live) => {
      const { page, cdp } = live
      const [title, history] = await Promise.all([
        page.title().catch((cause: unknown) => {
          if (/Execution context was destroyed|Cannot find context/.test(messageOf(cause))) return live.state.title
          throw cause
        }),
        cdp.send("Page.getNavigationHistory"),
      ])
      if (live.page !== page || live.closed) return
      const url = page.url()
      live.state = {
        ...live.state,
        title,
        url: url === "about:blank" ? live.state.url : url,
        back: history.currentIndex > 0 && history.entries[history.currentIndex - 1]?.url !== "about:blank",
        forward: history.currentIndex < history.entries.length - 1,
      }
    }

    const navigate = (live: Live, work: () => Promise<unknown>, url?: string) => {
      const page = live.page
      const epoch = ++live.navigationEpoch
      live.state = { ...live.state, url: url ?? live.state.url, loading: true, failure: null }
      run(
        async () => {
          if (live.closed || live.page !== page || epoch !== live.navigationEpoch) return
          await cancelPick(live)
          await releaseInput(live)
          if (live.closed || live.page !== page || epoch !== live.navigationEpoch) return
          await work()
          if (!live.closed && live.page === page && epoch === live.navigationEpoch) {
            live.state = { ...live.state, loading: false }
            await metadata(live)
          }
        },
        (cause) => {
          if (live.page === page && epoch === live.navigationEpoch) recordFailure(live, cause)
        },
      )
    }

    const pick = (live: Live) => {
      const { page, cdp } = live
      const epoch = ++live.pickEpoch
      live.state = { ...live.state, pick: { kind: "selecting" } }
      const current = () => !live.closed && live.page === page && live.pickEpoch === epoch
      run(
        async () => {
          const result: unknown = await page.evaluate(PICK_ELEMENT_SCRIPT)
          if (!current()) return
          const picked = Schema.decodeUnknownSync(Schema.NullOr(PagePick))(result)
          if (picked === null) {
            live.state = { ...live.state, pick: { kind: "idle" } }
            return
          }
          const x = Math.max(0, picked.rect.x)
          const y = Math.max(0, picked.rect.y)
          const width = Math.min(picked.rect.width, live.viewport.width - x)
          const height = Math.min(picked.rect.height, live.viewport.height - y)
          if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) {
            throw new BrowserError({ message: "The selected element is outside the browser viewport" })
          }
          const { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics")
          const screenshot = await page.screenshot({
            type: "png",
            clip: { x: x + cssVisualViewport.pageX, y: y + cssVisualViewport.pageY, width, height },
            timeout: 5000,
          })
          if (!current()) return
          const attachment = await Effect.runPromise(
            attachments.stage(live.threadId, {
              dataUrl: `data:image/png;base64,${screenshot.toString("base64")}`,
              name: "browser-element.png",
            }),
          )
          if (current()) {
            live.state = {
              ...live.state,
              pick: { kind: "picked", attachment: { ...attachment, element: picked.element } },
            }
          }
        },
        (cause) => {
          if (current()) live.state = { ...live.state, pick: { kind: "failed", message: messageOf(cause) } }
        },
      )
    }

    const setupPage = async (live: Live, page: Page, cdp: CDPSession) => {
      const current = () => !live.closed && live.page === page && live.cdp === cdp
      const failed = (cause: unknown) => {
        if (current()) recordFailure(live, cause)
      }
      const onFrame = (event: unknown) => {
        try {
          const { sessionId } = Schema.decodeUnknownSync(ScreencastAck)(event)
          run(() => cdp.send("Page.screencastFrameAck", { sessionId }), failed)
          const frame = Schema.decodeUnknownSync(ScreencastFrame)(event)
          if (current() && live.casting) {
            live.latest = Schema.decodeUnknownSync(BrowserFrame)({
              sequence: ++live.sequence,
              jpeg: frame.data,
              width: frame.metadata.deviceWidth,
              height: frame.metadata.deviceHeight,
            })
          }
        } catch (cause) {
          failed(cause)
        }
      }
      const onDialog = (dialog: Dialog) => run(() => dialog.dismiss(), failed)
      const onDownload = (download: Download) => {
        failed("Downloads are not supported in the remote browser")
        run(() => download.cancel(), failed)
      }
      const onFileChooser = (chooser: FileChooser) => run(() => chooser.setFiles([]), failed)
      const onPopup = (popup: Page) => {
        if (current()) adopt(live, popup, page)
        else run(() => popup.close(), failed)
      }
      const onRequest = (request: Request) => {
        if (current() && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          live.state = { ...live.state, loading: true }
        }
      }
      const onCrash = () => failed("The browser page crashed. Close this tab and open it again.")
      const onClose = () => {
        if (current() && live.adoption === null) run(() => closeLive(live), failed)
      }
      const onNavigation = (frame: Frame) => {
        if (!current() || frame !== page.mainFrame()) return
        live.pickEpoch += 1
        live.state = { ...live.state, url: frame.url(), pick: { kind: "idle" } }
        if (frame.url() !== "about:blank" && !isWebUrl(frame.url())) {
          failed("Only HTTP and HTTPS pages can be opened in the browser")
          run(() => cdp.send("Page.stopLoading"), failed)
        }
      }
      const onReady = () => {
        if (current()) live.state = { ...live.state, loading: false }
      }
      await cdp.send("Page.enable")
      cdp.on("Page.screencastFrame", onFrame)
      page.on("dialog", onDialog)
      page.on("download", onDownload)
      page.on("filechooser", onFileChooser)
      page.on("popup", onPopup)
      page.on("request", onRequest)
      page.on("crash", onCrash)
      page.on("close", onClose)
      page.on("framenavigated", onNavigation)
      page.on("domcontentloaded", onReady)
      return async () => {
        cdp.off("Page.screencastFrame", onFrame)
        page.off("dialog", onDialog)
        page.off("download", onDownload)
        page.off("filechooser", onFileChooser)
        page.off("popup", onPopup)
        page.off("request", onRequest)
        page.off("crash", onCrash)
        page.off("close", onClose)
        page.off("framenavigated", onNavigation)
        page.off("domcontentloaded", onReady)
        try {
          await cdp.detach()
        } catch (cause) {
          if (!page.isClosed()) throw cause
        }
      }
    }

    const adopt = (live: Live, popup: Page, source: Page): void => {
      const previous = live.adoption
      live.navigationEpoch += 1
      live.pickEpoch += 1
      const pending = (async () => {
        await previous
        try {
          if (live.closed || live.page !== source) {
            await popup.close()
            return
          }
          if (popup.url() === "about:blank") {
            try {
              await popup.waitForFunction(
                () => location.href !== "about:blank" || document.title !== "" || document.body?.hasChildNodes(),
                undefined,
                { timeout: 5000 },
              )
            } catch (cause) {
              if (!(cause instanceof errors.TimeoutError)) throw cause
            }
          }
          if (popup.url() !== "about:blank" && !isWebUrl(popup.url())) {
            throw new BrowserError({ message: "Only HTTP and HTTPS pages can be opened in the browser" })
          }
          live.state = { ...live.state, loading: true }
          await cancelPick(live)
          if (!source.isClosed()) {
            await releaseInput(live)
            await casting(live, false)
          }
          live.keys.clear()
          live.buttons.clear()
          await popup.setViewportSize(live.viewport)
          const cdp = await popup.context().newCDPSession(popup)
          const detach = await setupPage(live, popup, cdp)
          const loading = await popup.evaluate("document.readyState").then(
            (state: unknown) => state === "loading",
            (cause: unknown) => {
              if (/Execution context was destroyed|Cannot find context/.test(messageOf(cause))) return true
              throw cause
            },
          )
          if (live.closed || live.page !== source) {
            await detach()
            await popup.close()
            return
          }
          const detachPrevious = live.detachPage
          live.page = popup
          live.cdp = cdp
          live.detachPage = detach
          live.latest = null
          live.casting = false
          live.state = {
            url: popup.url(),
            title: "",
            loading,
            back: false,
            forward: false,
            failure: null,
            pick: { kind: "idle" },
          }
          await detachPrevious().finally(() => source.close({ runBeforeUnload: false }))
          await metadata(live)
        } catch (cause) {
          if (!live.closed) recordFailure(live, cause)
          if (live.page !== popup) await popup.close()
        }
      })()
      live.adoption = pending
      const finish = () => {
        if (live.adoption === pending) live.adoption = null
      }
      void pending.then(finish, finish)
      run(
        () => pending,
        (cause) => recordFailure(live, cause),
      )
    }

    const ready = async (live: Live) => {
      while (live.adoption !== null) await live.adoption
      if (live.closed) throw new BrowserError({ message: "Browser session has expired" })
    }

    const find = (threadId: string, sessionId: string) => {
      const live = sessions.get(sessionId)
      if (!live || live.closed || live.threadId !== threadId) {
        throw new BrowserError({ message: "Browser session does not belong to this thread or has expired" })
      }
      live.lease = Date.now()
      return live
    }

    const open = (input: RpcRequest<"browser.open">) =>
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(RpcMethods["browser.open"].request)(input).pipe(Effect.mapError(failure))
        yield* activeWorkspace(input.threadId).pipe(Effect.mapError(failure))
        return yield* Effect.tryPromise({
          try: async () => {
            const owner = retainContext(input.threadId)
            let page: Page | undefined
            try {
              const context = await owner.context
              page = await context.newPage()
              await page.setViewportSize({ width: input.width, height: input.height })
              const cdp = await context.newCDPSession(page)
              const live: Live = {
                id: randomUUID(),
                threadId: input.threadId,
                owner,
                page,
                cdp,
                detachPage: () => cdp.detach(),
                adoption: null,
                keys: new Map(),
                buttons: new Set(),
                state: {
                  url: input.url,
                  title: "",
                  loading: false,
                  back: false,
                  forward: false,
                  failure: null,
                  pick: { kind: "idle" },
                },
                viewport: { width: input.width, height: input.height },
                latest: null,
                sequence: 0,
                lease: Date.now(),
                casting: false,
                closed: false,
                pickEpoch: 0,
                navigationEpoch: 0,
                pointer: { x: 0, y: 0 },
                input: Promise.resolve(),
              }
              live.detachPage = await setupPage(live, page, cdp)
              if (disposed) throw new BrowserError({ message: "Browser service has stopped" })
              sessions.set(live.id, live)
              navigate(live, () => live.page.goto(input.url, { waitUntil: "domcontentloaded" }), input.url)
              return { sessionId: live.id }
            } catch (cause) {
              await page?.close().catch(() => undefined)
              await releaseContext(input.threadId, owner)
              throw cause
            }
          },
          catch: failure,
        })
      })

    const execute = async (live: Live, action: BrowserCommand) => {
      const { page, cdp } = live
      switch (action.kind) {
        case "navigate":
          navigate(live, () => page.goto(action.url, { waitUntil: "domcontentloaded" }), action.url)
          return
        case "back":
          navigate(live, () => page.goBack({ waitUntil: "domcontentloaded" }))
          return
        case "forward":
          navigate(live, () => page.goForward({ waitUntil: "domcontentloaded" }))
          return
        case "reload":
          navigate(live, () => page.reload({ waitUntil: "domcontentloaded" }))
          return
        case "stop":
          live.navigationEpoch += 1
          await cdp.send("Page.stopLoading")
          live.state = { ...live.state, loading: false }
          return
        case "resize": {
          await casting(live, false)
          live.viewport = { width: action.width, height: action.height }
          await page.setViewportSize(live.viewport)
          live.latest = null
          return
        }
        case "pointer":
          await queueInput(live, async () => {
            live.pointer = { x: action.x, y: action.y }
            if (action.button !== "none") {
              if (action.type === "mousePressed") live.buttons.add(action.button)
              if (action.type === "mouseReleased") live.buttons.delete(action.button)
            }
            await cdp.send("Input.dispatchMouseEvent", {
              type: action.type,
              x: action.x,
              y: action.y,
              button: action.button,
              buttons: action.buttons,
              clickCount: action.clickCount,
              modifiers: action.modifiers,
              deltaX: action.deltaX,
              deltaY: action.deltaY,
            })
          })
          return
        case "key":
          await queueInput(live, async () => {
            if (action.type === "keyDown") live.keys.set(action.code, action)
            else live.keys.delete(action.code)
            const editing =
              process.platform !== "darwin" && action.type === "keyDown" && (action.modifiers & 7) === 4
                ? META_EDIT_COMMANDS[`${action.modifiers & 8 ? "Shift+" : ""}${action.code}`]
                : undefined
            await cdp.send("Input.dispatchKeyEvent", {
              type: action.type,
              key: action.key,
              code: action.code,
              windowsVirtualKeyCode: action.keyCode,
              modifiers: action.modifiers,
              text: action.type === "keyDown" ? action.text : undefined,
              commands: editing === undefined ? undefined : [editing],
            })
          })
          return
        case "text":
          await queueInput(live, () => cdp.send("Input.insertText", { text: action.text }))
          return
        case "release":
          await releaseInput(live)
          return
        case "pick":
          await cancelPick(live)
          if (action.enabled) pick(live)
          return
      }
    }

    const command = (input: RpcRequest<"browser.command">) =>
      Effect.tryPromise({
        try: async () => {
          Schema.decodeUnknownSync(RpcMethods["browser.command"].request)(input)
          const live = find(input.threadId, input.sessionId)
          for (const action of input.commands) {
            await ready(live)
            const page = live.page
            try {
              await execute(live, action)
            } catch (cause) {
              if (live.page === page && live.adoption === null) throw cause
            }
          }
        },
        catch: failure,
      })

    const frame = (input: RpcRequest<"browser.frame">) =>
      Effect.tryPromise({
        try: async () => {
          Schema.decodeUnknownSync(RpcMethods["browser.frame"].request)(input)
          const live = find(input.threadId, input.sessionId)
          while (true) {
            await ready(live)
            const page = live.page
            try {
              await casting(live, input.visible)
              if (!input.visible) await releaseInput(live)
              if (input.visible) await sleep(100)
              if (live.closed) throw new BrowserError({ message: "Browser session has expired" })
              await metadata(live)
              if (input.visible && live.latest === null) await capture(live)
              if (live.page !== page || live.adoption !== null) continue
              return {
                state: live.state,
                frame: input.visible && live.latest && live.latest.sequence > input.after ? live.latest : null,
              }
            } catch (cause) {
              if (live.page === page && live.adoption === null) throw cause
            }
          }
        },
        catch: failure,
      })

    const close = (input: RpcRequest<"browser.close">) =>
      Effect.tryPromise({
        try: async () => {
          Schema.decodeUnknownSync(RpcMethods["browser.close"].request)(input)
          const live = sessions.get(input.sessionId)
          if (!live) return
          if (live.threadId !== input.threadId)
            throw new BrowserError({ message: "Browser session belongs to another thread" })
          await closeLive(live)
        },
        catch: failure,
      })

    const sweep = Effect.promise(async () => {
      const expired = [...sessions.values()].filter((live) => Date.now() - live.lease > (options.leaseMs ?? 60000))
      await Promise.all(expired.map((live) => closeLive(live)))
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("browser cleanup failed", cause)))
    yield* sweep.pipe(Effect.schedule(Schedule.spaced(options.sweepMs ?? 10000)), Effect.forkScoped)
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        disposed = true
        await Promise.allSettled([...sessions.values()].map(closeLive))
        const browser = await processPromise?.catch(() => null)
        await browser?.close()
        processPromise = null
      }),
    )
    return Browser.of({ open, command, frame, close })
  })

export const browserLayer = (options: BrowserOptions = {}) => Layer.effect(Browser, make(options))
export const layer = browserLayer()
