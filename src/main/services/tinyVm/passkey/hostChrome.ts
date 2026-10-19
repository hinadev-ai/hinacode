import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Schedule, Schema } from "effect"
import { attachToTarget, browserSocketUrl, CdpConnection } from "./cdp.ts"
import {
  ceremonyError,
  decodeCeremonyResult,
  notAllowed,
  PasskeyError,
  type CeremonyOutcome,
  type CeremonyRequest,
} from "./protocol.ts"

export interface HostChrome {
  readonly ensureStarted: Effect.Effect<void, PasskeyError>
  readonly runCeremony: (request: CeremonyRequest) => Effect.Effect<CeremonyOutcome>
  readonly cancel: Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export const chromeCandidates = (platform: string, home: string): ReadonlyArray<string> =>
  platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ]
    : []

export const findChrome = (platform: string, home: string, exists: (path: string) => boolean): string | undefined =>
  chromeCandidates(platform, home).find(exists)

const CreatedTarget = Schema.Struct({ targetId: Schema.String })

// Sites often start a conditional passkey request on load for autofill. Chrome runs one WebAuthn request
// per page, so that request would block the ceremony with InvalidStateError. Park conditional calls from
// page scripts and keep the bound originals for the banner's own call.
const PARK_CONDITIONAL = [
  "if (navigator.credentials) {",
  "  window.__hinacodeOriginalCreate = navigator.credentials.create.bind(navigator.credentials)",
  "  window.__hinacodeOriginalGet = navigator.credentials.get.bind(navigator.credentials)",
  "  navigator.credentials.get = (options) =>",
  "    options && options.mediation === 'conditional'",
  "      ? new Promise(() => {})",
  "      : window.__hinacodeOriginalGet(options)",
  "}",
].join("\n")

const freePort = Effect.callback<number, PasskeyError>((resume) => {
  const server = createServer()
  server.once("error", (cause) =>
    resume(Effect.fail(new PasskeyError({ message: `Could not reserve a port for Chrome: ${cause.message}` }))),
  )
  server.listen(0, "127.0.0.1", () => {
    const address = server.address()
    server.close()
    if (address === null || typeof address === "string") {
      resume(Effect.fail(new PasskeyError({ message: "Could not reserve a port for Chrome" })))
      return
    }
    resume(Effect.succeed(address.port))
  })
})

const OVERLAY = [
  "(() => {",
  "  const request = window.__hinacodeRequest",
  "  document.getElementById('__hinacode-passkey')?.remove()",
  "  const bar = document.createElement('div')",
  "  bar.id = '__hinacode-passkey'",
  "  bar.style.cssText = 'position:fixed;inset:0 0 auto 0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 18px;background:#111827;color:#f9fafb;font:14px -apple-system,system-ui,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.35)'",
  "  const text = document.createElement('div')",
  "  const title = document.createElement('strong')",
  "  title.textContent = 'HinaCode VM passkey request'",
  "  const detail = document.createElement('div')",
  "  detail.textContent = (request.kind === 'create' ? 'Create a passkey for ' : 'Sign in to ') + request.origin",
  "  detail.style.opacity = '.75'",
  "  text.append(title, detail)",
  "  const actions = document.createElement('div')",
  "  actions.style.cssText = 'display:flex;gap:8px;flex:none'",
  "  const makeButton = (label, primary) => {",
  "    const button = document.createElement('button')",
  "    button.textContent = label",
  "    button.style.cssText = 'padding:8px 14px;border-radius:8px;border:1px solid ' + (primary ? '#2563eb' : '#4b5563') + ';background:' + (primary ? '#2563eb' : 'transparent') + ';color:#fff;font:inherit;cursor:pointer'",
  "    return button",
  "  }",
  "  const done = (payload) => window.__hinacodeCeremonyDone(JSON.stringify(payload))",
  "  const approve = makeButton('Use passkey', true)",
  "  const cancel = makeButton('Cancel', false)",
  "  cancel.addEventListener('click', () => done({ error: { name: 'NotAllowedError', message: 'The user cancelled the passkey request on this Mac' } }))",
  "  approve.addEventListener('click', async () => {",
  "    approve.disabled = true",
  "    cancel.disabled = true",
  "    approve.textContent = 'Waiting for approval...'",
  "    try {",
  "      const parsed = JSON.parse(request.requestDetailsJson)",
  "      // The guest proxy adds this extension input for allowlisted remote desktop clients. This ceremony",
  "      // already runs on the real origin. Keeping the input makes Chrome reject the call as not permitted.",
  "      if (parsed.extensions) delete parsed.extensions.remoteDesktopClientOverride",
  "      const create = window.__hinacodeOriginalCreate || navigator.credentials.create.bind(navigator.credentials)",
  "      const get = window.__hinacodeOriginalGet || navigator.credentials.get.bind(navigator.credentials)",
  "      const credential = request.kind === 'create'",
  "        ? await create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(parsed) })",
  "        : await get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(parsed) })",
  "      if (!credential) throw new DOMException('Chrome returned no credential', 'NotAllowedError')",
  "      done({ responseJson: JSON.stringify(credential.toJSON()) })",
  "    } catch (error) {",
  "      done({ error: { name: error && error.name ? error.name : 'UnknownError', message: error && error.message ? error.message : String(error) } })",
  "    }",
  "  })",
  "  actions.append(cancel, approve)",
  "  bar.append(text, actions)",
  "  document.documentElement.appendChild(bar)",
  "  approve.focus()",
  "})()",
].join("\n")

interface Active {
  readonly targetId: string
  readonly sessionId: string
  finish: ((outcome: CeremonyOutcome) => void) | undefined
}

export const makeHostChrome = (profileDir: string): Effect.Effect<HostChrome> =>
  Effect.sync(() => {
    let child: ChildProcess | undefined
    let connection: CdpConnection | undefined
    let baseUrl: string | undefined
    let active: Active | undefined

    const finishActive = (outcome: CeremonyOutcome) => {
      const finish = active?.finish
      if (active !== undefined) active.finish = undefined
      finish?.(outcome)
    }

    const reset = () => {
      finishActive(ceremonyError("UnknownError", "The Chrome window for passkey approval closed"))
      connection = undefined
      baseUrl = undefined
      active = undefined
    }

    const start = Effect.gen(function* () {
      if (connection !== undefined) return connection
      const binary = findChrome(process.platform, homedir(), existsSync)
      if (binary === undefined) {
        return yield* new PasskeyError({
          message:
            process.platform === "darwin"
              ? "Google Chrome was not found on this Mac. Passkey approval runs in Chrome."
              : "Passkey approval in Chrome is only built on macOS for now.",
        })
      }
      yield* Effect.tryPromise({
        try: () => mkdir(profileDir, { recursive: true }),
        catch: (cause) =>
          new PasskeyError({
            message: `Could not create the Chrome profile folder: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      })
      const port = yield* freePort
      baseUrl = `http://127.0.0.1:${port}`
      child = spawn(
        binary,
        [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--new-window",
          "about:blank",
        ],
        { stdio: "ignore" },
      )
      child.once("exit", () => {
        child = undefined
        reset()
      })
      connection = yield* browserSocketUrl(baseUrl).pipe(
        Effect.flatMap(CdpConnection.connect),
        Effect.retry({ schedule: Schedule.spaced("500 millis").pipe(Schedule.upTo({ duration: "20 seconds" })) }),
        Effect.mapError(() => new PasskeyError({ message: "Chrome started but its DevTools port did not answer" })),
      )
      connection.on("Runtime.bindingCalled", (params, sessionId) => {
        if (active === undefined || sessionId !== active.sessionId) return
        if (typeof params !== "object" || params === null || !("payload" in params)) return
        const decoded = decodeCeremonyResult((params as { payload: unknown }).payload)
        if (decoded._tag === "None") {
          finishActive(ceremonyError("UnknownError", "Chrome sent a passkey result HinaCode does not understand"))
          return
        }
        finishActive(
          "responseJson" in decoded.value
            ? { type: "ok", responseJson: decoded.value.responseJson }
            : ceremonyError(decoded.value.error.name, decoded.value.error.message),
        )
      })
      connection.onClose = reset
      return connection
    })

    const closeTarget = (targetId: string) =>
      connection === undefined ? Effect.void : connection.call("Target.closeTarget", { targetId }).pipe(Effect.ignore)

    const ceremony = (request: CeremonyRequest) =>
      Effect.gen(function* () {
        const cdp = yield* start
        const { targetId } = yield* cdp.call("Target.createTarget", { url: "about:blank" }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(CreatedTarget)),
          Effect.mapError((error) =>
            error instanceof PasskeyError ? error : new PasskeyError({ message: "Chrome could not open a tab" }),
          ),
        )
        const sessionId = yield* attachToTarget(cdp, targetId)
        active = { targetId, sessionId, finish: undefined }
        yield* cdp.call("Runtime.enable", {}, sessionId)
        yield* cdp.call("Runtime.addBinding", { name: "__hinacodeCeremonyDone" }, sessionId)
        yield* cdp.call("Page.enable", {}, sessionId)
        yield* cdp.call("Page.addScriptToEvaluateOnNewDocument", { source: PARK_CONDITIONAL }, sessionId)
        yield* cdp.call("Page.navigate", { url: `${request.origin}/` }, sessionId)
        const opened = yield* cdp
          .evaluate(
            sessionId,
            "JSON.stringify({ origin: location.origin, secure: window.isSecureContext, ready: document.readyState })",
          )
          .pipe(
            Effect.flatMap((value) => {
              if (typeof value !== "string") return Effect.fail(new PasskeyError({ message: "unreadable page" }))
              const page = JSON.parse(value) as { origin: string; secure: boolean; ready: string }
              return page.origin === request.origin && page.secure && page.ready !== "loading"
                ? Effect.succeed(true)
                : Effect.fail(new PasskeyError({ message: "page not ready" }))
            }),
            Effect.retry({ schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: "15 seconds" })) }),
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          )
        if (!opened)
          return ceremonyError("SecurityError", `Chrome could not open ${request.origin} for the passkey ceremony`)
        yield* cdp.evaluate(
          sessionId,
          `window.__hinacodeRequest = ${JSON.stringify({ kind: request.kind, origin: request.origin, requestDetailsJson: request.requestDetailsJson })}`,
        )
        yield* cdp.evaluate(sessionId, OVERLAY)
        return yield* Effect.callback<CeremonyOutcome>((resume) => {
          if (active !== undefined && active.targetId === targetId) {
            active.finish = (outcome) => resume(Effect.succeed(outcome))
          } else {
            resume(Effect.succeed(notAllowed("The passkey request was replaced by a newer one")))
          }
          return closeTarget(targetId)
        })
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            const targetId = active?.targetId
            active = undefined
            return targetId === undefined ? Effect.void : closeTarget(targetId)
          }),
        ),
      )

    const runCeremony = (request: CeremonyRequest) =>
      ceremony(request).pipe(
        Effect.catch((error: PasskeyError) => Effect.succeed(ceremonyError("UnknownError", error.message))),
      )

    const cancel = Effect.suspend(() => {
      const targetId = active?.targetId
      finishActive(notAllowed("The user cancelled the passkey request"))
      return targetId === undefined ? Effect.void : closeTarget(targetId)
    })

    const close = Effect.sync(() => {
      connection?.close()
      child?.kill("SIGTERM")
      child = undefined
      reset()
    })

    return { ensureStarted: Effect.asVoid(start), runCeremony, cancel, close } satisfies HostChrome
  })
