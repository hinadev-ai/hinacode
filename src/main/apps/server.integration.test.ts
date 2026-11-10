import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createServer, request as httpRequest, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import { type AgentEvent, unlistedModel } from "../../shared/agent.ts"
import { defaultSettings } from "../../shared/domain.ts"
import { ClaudeProvider } from "../agents/claude/index.ts"
import { CodexProvider } from "../agents/codex/index.ts"
import { MagpieProvider } from "../agents/magpie/index.ts"
import { MuseProvider } from "../agents/muse/index.ts"
import { OpencodeProvider } from "../agents/opencode/index.ts"
import type { AgentProvider } from "../agents/provider.ts"
import { seedThread } from "../db/testing.ts"
import { RemoteAccess } from "../remote/access.ts"
import { CREDENTIAL_SECRET } from "../remote/relay.ts"
import { unusedLoopbackPort } from "../remote/testing.ts"
import { Secrets } from "../services/Secrets.ts"
import { Settings } from "../services/Settings.ts"
import { Threads } from "../services/Threads.ts"
import { makeTestAppLayer } from "../testing.ts"
import { AppConnections } from "./AppConnections.ts"

vi.mock("electron", () => ({
  Notification: EventTarget,
  app: { getPath: () => "", focus: () => {} },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
}))

const HOSTNAME = "desk.relay.example"
const ISSUER = `https://${HOSTNAME}`
const REDIRECT = "https://chat.example/callback"
const VERIFIER = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url")
const TOOLS = [
  "create_thread",
  "list_projects",
  "list_threads",
  "read_thread",
  "search_threads",
  "send_to_thread",
  "stop_thread",
  "wait_for_thread",
]
const EVERY_PATH = [
  "/",
  "/mcp",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/wait",
  "/oauth/sign-in",
  "/oauth/signed-in",
  "/oauth/answer",
  "/oauth/token",
]

const replyingProvider = (id: AgentProvider["id"]): AgentProvider => ({
  id,
  listModels: Effect.succeed([unlistedModel(`${id}-model`, id)]),
  account: () => Effect.succeed({ type: "signedOut" }),
  planLimits: () => Effect.succeed(null),
  usage: () => Effect.succeed(null),
  listCommands: () => Effect.succeed([]),
  runTurn: (input) =>
    Stream.fromIterable<AgentEvent>([
      { type: "text_delta", text: `Done: ${input.prompt}` },
      { type: "turn_completed" },
    ]),
  steer: () => Effect.void,
  interrupt: () => Effect.void,
  respondApproval: () => Effect.succeed(false),
  respondQuestion: () => Effect.void,
  setAccessMode: () => Effect.void,
})

const providers = Layer.mergeAll(
  Layer.succeed(ClaudeProvider, replyingProvider("claude")),
  Layer.succeed(CodexProvider, replyingProvider("codex")),
  Layer.succeed(MuseProvider, replyingProvider("muse")),
  Layer.succeed(OpencodeProvider, replyingProvider("opencode")),
  Layer.succeed(MagpieProvider, replyingProvider("magpie")),
)

const HOST_CREDENTIAL = "host-credential"
const OWNER_CODE = "owner-signed-in"
const fakeRelay = { url: "", challenges: [] as Array<string> }
let relayServer: Server

beforeAll(async () => {
  relayServer = createServer((request, response) => {
    let text = ""
    request.on("data", (chunk) => (text += chunk))
    request.on("end", () => {
      const { code, codeVerifier } = JSON.parse(text || "{}") as { code?: string; codeVerifier?: string }
      const challenge = createHash("sha256")
        .update(codeVerifier ?? "")
        .digest("base64url")
      const owner =
        request.url === "/v1/host/sign-in-codes/verify" &&
        request.headers.authorization === `Bearer ${HOST_CREDENTIAL}` &&
        code === OWNER_CODE &&
        fakeRelay.challenges.includes(challenge)
      response.writeHead(owner ? 200 : 410, { "content-type": "application/json" })
      response.end(JSON.stringify(owner ? { name: "Dev", email: "dev@example.test" } : { error: "gone" }))
    })
  })
  await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve))
  const address = relayServer.address()
  fakeRelay.url = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : ""
})

afterAll(() => new Promise<void>((resolve) => relayServer.close(() => resolve())))

const makeApp = (dbPath: string) => makeTestAppLayer(dbPath, { providers, relay: { serviceUrl: fakeRelay.url } })

interface App {
  readonly runtime: ManagedRuntime.ManagedRuntime<Layer.Success<ReturnType<typeof makeApp>>, unknown>
  readonly origin: string
  readonly repo: string
}

const linkRelay = ({ runtime }: App, hostname: string | null = HOSTNAME) =>
  runtime.runPromise(
    RemoteAccess.use((access) =>
      access.report({ relay: hostname === null ? { state: "off" } : { state: "connected", hostname } }),
    ),
  )

const withApp = async (use: (app: App) => Promise<void>) => {
  const dir = mkdtempSync(join(tmpdir(), "kk-apps-server-"))
  const repo = join(dir, "repo")
  mkdirSync(repo)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  const runtime = ManagedRuntime.make(makeApp(join(dir, "hinacode.sqlite")))
  try {
    const port = await runtime.runPromise(AppConnections.use((connections) => Effect.sync(() => connections.port())))
    const app = { runtime, origin: `http://127.0.0.1:${port}`, repo }
    await linkRelay(app)
    await runtime.runPromise(Secrets.use((secrets) => secrets.set(CREDENTIAL_SECRET, HOST_CREDENTIAL)))
    await use(app)
  } finally {
    await runtime.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

const status = ({ runtime }: App) => runtime.runPromise(AppConnections.use((connections) => connections.status))

const start = ({ runtime }: App) => runtime.runPromise(AppConnections.use((connections) => connections.start))

const answerRequest = ({ runtime }: App, id: string, approve: boolean) =>
  runtime.runPromise(AppConnections.use((connections) => connections.answer({ id, approve })))

const get = ({ origin }: App, path: string, params: Record<string, string> = {}) =>
  fetch(`${origin}${path}?${new URLSearchParams(params)}`, { redirect: "manual" })

const postForm = ({ origin }: App, path: string, form: Record<string, string>) =>
  fetch(`${origin}${path}`, { method: "POST", body: new URLSearchParams(form), redirect: "manual" })

const register = async ({ origin }: App, metadata: object = { client_name: "Chat app", redirect_uris: [REDIRECT] }) =>
  fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(metadata),
  })

const registered = async (app: App, metadata?: object) => {
  const { client_id: clientId } = (await (await register(app, metadata)).json()) as { client_id: string }
  return clientId
}

const authorization = (clientId: string, overrides: Record<string, string> = {}) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "state-1",
  resource: `${ISSUER}/mcp`,
  ...overrides,
})

const askToConnect = async (app: App, clientId: string) => {
  const asked = await get(app, "/oauth/authorize", authorization(clientId))
  expect(asked.status).toBe(303)
  const waiting = new URL(asked.headers.get("location")!, app.origin)
  return { path: waiting.pathname, request: waiting.searchParams.get("request")! }
}

const authorizationCode = async (app: App, clientId: string) => {
  await start(app)
  const { path, request } = await askToConnect(app, clientId)
  await answerRequest(app, request, true)
  const back = await get(app, path, { request })
  return new URL(back.headers.get("location")!).searchParams.get("code")!
}

const exchange = (app: App, clientId: string, code: string, overrides: Record<string, string> = {}) =>
  postForm(app, "/oauth/token", {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: VERIFIER,
    ...overrides,
  })

const connect = async (app: App) => {
  await start(app)
  const clientId = await registered(app)
  const answer = await exchange(app, clientId, await authorizationCode(app, clientId))
  return ((await answer.json()) as { access_token: string }).access_token
}

const initialize = (token?: string) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  }),
})

const withMcp = async <A>({ origin }: App, token: string, use: (client: Client) => Promise<A>) => {
  const client = new Client({ name: "test", version: "0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  try {
    return await use(client)
  } finally {
    await client.close()
  }
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ text?: string }>
  return { text: content.map((part) => part.text ?? "").join(""), isError: result.isError === true }
}

const statuses = async (app: App) => {
  const answers = await Promise.all(EVERY_PATH.map((path) => get(app, path)))
  return answers.map((answer) => answer.status)
}

const cookieFrom = (response: Response, name: string) => {
  const header = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`))
  return { header, pair: header?.split(";", 1)[0] ?? "" }
}

const withCookie = ({ origin }: App, path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, { ...init, redirect: "manual", headers: { ...init.headers, cookie } })

const signInAsOwner = async (app: App, request: string) => {
  const started = await get(app, "/oauth/sign-in", { request })
  expect(started.status).toBe(303)
  const relayPage = new URL(started.headers.get("location")!)
  fakeRelay.challenges.push(relayPage.searchParams.get("code_challenge")!)
  const signIn = cookieFrom(started, "hinacode_sign_in")
  const back = await withCookie(app, `/oauth/signed-in?code=${OWNER_CODE}`, signIn.pair)
  return { started, relayPage, signIn, back, owner: cookieFrom(back, "hinacode_owner") }
}

describe("approving on the web", () => {
  test("the owner signs in on the relay, then approves on the page", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const { path, request } = await askToConnect(app, clientId)
      const signedOut = await (await get(app, path, { request })).text()
      expect(signedOut).toContain(`href="/oauth/sign-in?request=${request}"`)
      expect(signedOut).not.toContain('name="decision"')

      const { relayPage, signIn, back, owner } = await signInAsOwner(app, request)
      expect(`${relayPage.origin}${relayPage.pathname}`).toBe(`${fakeRelay.url}/sign-in`)
      expect(relayPage.searchParams.get("redirect_uri")).toBe(`${ISSUER}/oauth/signed-in`)
      expect(signIn.header).toMatch(/; Path=\/oauth; .*HttpOnly; Secure; SameSite=Lax/)
      expect(back.status).toBe(303)
      expect(back.headers.get("location")).toBe(`${path}?request=${request}`)
      expect(owner.header).toMatch(/HttpOnly; Secure; SameSite=Lax/)

      const signedIn = await (await withCookie(app, `${path}?request=${request}`, owner.pair)).text()
      expect(signedIn).toContain('<button class="primary" name="decision" value="approve">Approve</button>')
      expect(signedIn).toContain("Signed in as <strong>dev@example.test</strong>")
      expect(signedIn).not.toContain('http-equiv="refresh"')

      const form = { method: "POST", body: new URLSearchParams({ request, decision: "approve" }) }
      expect((await withCookie(app, "/oauth/answer", "", form)).status).toBe(403)
      expect((await status(app)).requests).toHaveLength(1)

      const answered = await withCookie(app, "/oauth/answer", owner.pair, form)
      expect(answered.status).toBe(303)
      const done = await get(app, path, { request })
      const callback = new URL(done.headers.get("location")!)
      expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT)
      expect(callback.searchParams.get("code")).not.toBeNull()
      expect((await status(app)).requests).toEqual([])
    }))

  test("an owner cookie answers only the request it signed in for", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const first = await askToConnect(app, clientId)
      const second = await askToConnect(app, clientId)
      const { owner } = await signInAsOwner(app, first.request)
      const form = { method: "POST", body: new URLSearchParams({ request: second.request, decision: "approve" }) }
      expect((await withCookie(app, "/oauth/answer", owner.pair, form)).status).toBe(403)
      expect((await status(app)).requests).toHaveLength(2)
    }))

  test("a request keeps only its latest sign-in", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const { request } = await askToConnect(app, clientId)
      const first = cookieFrom(await get(app, "/oauth/sign-in", { request }), "hinacode_sign_in")
      const latest = await get(app, "/oauth/sign-in", { request })
      fakeRelay.challenges.push(new URL(latest.headers.get("location")!).searchParams.get("code_challenge")!)
      expect((await withCookie(app, `/oauth/signed-in?code=${OWNER_CODE}`, first.pair)).status).toBe(400)
      const kept = cookieFrom(latest, "hinacode_sign_in")
      expect((await withCookie(app, `/oauth/signed-in?code=${OWNER_CODE}`, kept.pair)).status).toBe(303)
    }))

  test("a sign-in the relay refuses, or one this page did not start, grants nothing", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const { request } = await askToConnect(app, clientId)
      const started = await get(app, "/oauth/sign-in", { request })
      const signIn = cookieFrom(started, "hinacode_sign_in")
      const refused = await withCookie(app, "/oauth/signed-in?code=forged", signIn.pair)
      expect(refused.status).toBe(403)
      expect(refused.headers.getSetCookie()).toEqual([])
      expect((await withCookie(app, `/oauth/signed-in?code=${OWNER_CODE}`, signIn.pair)).status).toBe(400)
      expect((await get(app, "/oauth/signed-in", { code: OWNER_CODE })).status).toBe(400)
      expect((await get(app, "/oauth/sign-in", { request: "made-up" })).status).toBe(404)
    }))
})

describe("app server", () => {
  test("an app registers, is approved, gets a token and drives threads", () =>
    withApp(async (app) => {
      await start(app)

      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        expect(await (await get(app, path)).json()).toMatchObject({
          resource: `${ISSUER}/mcp`,
          authorization_servers: [ISSUER],
        })
      }
      expect(await (await get(app, "/.well-known/oauth-authorization-server")).json()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: `${ISSUER}/oauth/token`,
        registration_endpoint: `${ISSUER}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
      })

      const registration = await register(app, { client_name: "Chat <b>app</b>", redirect_uris: [REDIRECT] })
      expect(registration.status).toBe(201)
      const { client_id: clientId } = (await registration.json()) as { client_id: string }

      const { path, request } = await askToConnect(app, clientId)
      expect((await status(app)).requests).toEqual([
        { id: request, name: "Chat <b>app</b>", redirectHost: "chat.example" },
      ])
      const page = await get(app, path, { request })
      expect(page.status).toBe(200)
      expect(page.headers.get("x-frame-options")).toBe("DENY")
      expect(page.headers.get("content-security-policy")).toContain("default-src 'none'")
      const html = await page.text()
      expect(html).toContain("Chat &#60;b&#62;app&#60;/b&#62;")
      expect(html).not.toContain("<b>app</b>")
      expect(html).toContain("chat.example")
      expect(html).toContain("run code on this machine")
      expect(html).toContain('<meta http-equiv="refresh" content="2">')
      expect(html).not.toMatch(/<script|src=/)
      expect(html).toContain("Sign in to approve")

      const answered = await answerRequest(app, request, true)
      expect(answered.requests).toEqual([])
      expect(answered.waitingUntil).toBeNull()
      const approved = await get(app, path, { request })
      expect(approved.status).toBe(302)
      const back = new URL(approved.headers.get("location")!)
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT)
      expect(back.searchParams.get("state")).toBe("state-1")
      expect((await get(app, path, { request })).status).toBe(404)

      const exchanged = await exchange(app, clientId, back.searchParams.get("code")!, { resource: `${ISSUER}/mcp` })
      expect(exchanged.status).toBe(200)
      expect(exchanged.headers.get("cache-control")).toBe("no-store")
      const token = (await exchanged.json()) as { access_token: string }
      expect(token).toEqual({ access_token: token.access_token, token_type: "Bearer", scope: "hinacode" })

      const [connection] = (await status(app)).connections
      expect(connection).toMatchObject({ name: "Chat <b>app</b>", lastUsedAt: null })

      const { projectId, threadId: seededThread } = await app.runtime.runPromise(seedThread({ rootPath: app.repo }))
      await withMcp(app, token.access_token, async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name).toSorted()).toEqual(TOOLS)

        expect(JSON.parse((await call(client, "list_projects")).text)).toEqual([
          { id: projectId, name: "demo", path: app.repo },
        ])

        const created = await call(client, "create_thread", {
          projectId,
          title: "From the chat app",
          prompt: "ship it",
          provider: "claude",
          model: "claude-model",
        })
        expect(created).toEqual({
          text: expect.stringMatching(/^Created thread \S+ "From the chat app" and sent it the prompt\.$/),
          isError: false,
        })
        const threadId = /^Created thread (\S+)/.exec(created.text)![1]!
        const thread = await app.runtime.runPromise(Threads.use((threads) => threads.get(threadId)))
        expect(thread).toMatchObject({ projectId, createdBy: `app:${connection!.id}`, provider: "claude" })

        const finished = await call(client, "wait_for_thread", { threadId })
        expect(finished.text).not.toContain("Still running.")
        expect(finished.text).toContain("Done: ship it")
        expect(finished.text).toContain(`created_by: app:${connection!.id}`)
        expect((await call(client, "read_thread", { threadId })).text).toBe(finished.text)

        const listed = JSON.parse((await call(client, "list_threads", { projectId })).text) as Array<{ id: string }>
        expect(listed.map((row) => row.id).toSorted()).toEqual([seededThread, threadId].toSorted())
        expect((await call(client, "list_threads", { projectId: "missing" })).isError).toBe(true)
      })
      expect((await status(app)).connections[0]?.lastUsedAt).not.toBeNull()
    }))

  test("refuses an MCP request larger than a megabyte", () =>
    withApp(async (app) => {
      const token = await connect(app)
      const request = initialize(token)
      const oversized = await fetch(`${app.origin}/mcp`, {
        ...request,
        body: request.body.replace('"test"', JSON.stringify("x".repeat(1024 * 1024))),
      })
      expect(oversized.status).toBe(413)

      const chunked = await fetch(`${app.origin}/mcp`, {
        ...request,
        body: new Blob([request.body]).stream(),
        duplex: "half",
      } as RequestInit)
      expect(chunked.status).toBe(413)
    }))

  test("create_thread falls back to the developer's default agent and model", () =>
    withApp(async (app) => {
      const token = await connect(app)
      const { projectId } = await app.runtime.runPromise(seedThread({ rootPath: app.repo }))
      await app.runtime.runPromise(
        Settings.use((settings) =>
          settings.set({
            defaultProvider: "codex",
            defaultModel: { ...defaultSettings.defaultModel, codex: "gpt-default" },
          }),
        ),
      )
      await withMcp(app, token, async (client) => {
        const created = await call(client, "create_thread", { projectId, title: "Defaults", prompt: "go" })
        expect(created.isError).toBe(false)
        const threadId = /^Created thread (\S+)/.exec(created.text)![1]!
        expect(await app.runtime.runPromise(Threads.use((threads) => threads.get(threadId)))).toMatchObject({
          provider: "codex",
          model: "gpt-default",
        })
      })
    }))

  test("asking to connect before choosing the app in HinaCode explains where to start", () =>
    withApp(async (app) => {
      await connect(app)
      const clientId = await registered(app)
      const early = await get(app, "/oauth/authorize", authorization(clientId))
      expect(early.status).toBe(409)
      expect(await early.text()).toContain("Settings &#62; Connections &#62; Apps")
      expect((await status(app)).requests).toEqual([])
    }))

  test("denying sends the app back without a code and keeps waiting for another", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const { path, request } = await askToConnect(app, clientId)
      await answerRequest(app, request, false)
      const denied = await get(app, path, { request })
      expect(denied.status).toBe(302)
      const back = new URL(denied.headers.get("location")!)
      expect(back.searchParams.get("error")).toBe("access_denied")
      expect(back.searchParams.get("state")).toBe("state-1")
      expect(back.searchParams.has("code")).toBe(false)
      expect((await status(app)).waitingUntil).not.toBeNull()
    }))

  test("approving one request turns the others away", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const first = await askToConnect(app, clientId)
      const second = await askToConnect(app, clientId)
      await answerRequest(app, second.request, true)
      const turnedAway = await get(app, first.path, { request: first.request })
      expect(new URL(turnedAway.headers.get("location")!).searchParams.get("error")).toBe("access_denied")
      expect((await get(app, "/oauth/authorize", authorization(clientId))).status).toBe(409)
    }))

  test("at most five requests wait at once", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      for (let asked = 1; asked <= 5; asked++) await askToConnect(app, clientId)
      expect((await get(app, "/oauth/authorize", authorization(clientId))).status).toBe(409)
      expect((await status(app)).requests).toHaveLength(5)
    }))

  test("an authorization code is exchanged once", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const code = await authorizationCode(app, clientId)
      expect((await exchange(app, clientId, code)).status).toBe(200)

      const reused = await exchange(app, clientId, code)
      expect(reused.status).toBe(400)
      expect(await reused.json()).toMatchObject({ error: "invalid_grant" })
      expect((await status(app)).connections).toHaveLength(1)
    }))

  test("a token needs the PKCE verifier, the client and the redirect URI the code was issued for", () =>
    withApp(async (app) => {
      await connect(app)
      const clientId = await registered(app)
      const otherClient = await registered(app, { client_name: "Other", redirect_uris: [REDIRECT] })
      const refusals: ReadonlyArray<Record<string, string>> = [
        { code_verifier: VERIFIER.split("").toReversed().join("") },
        { client_id: otherClient },
        { redirect_uri: "https://chat.example/elsewhere" },
      ]
      for (const overrides of refusals) {
        const refused = await exchange(app, clientId, await authorizationCode(app, clientId), overrides)
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error: "invalid_grant" })
      }

      const wrongResource = await exchange(app, clientId, await authorizationCode(app, clientId), {
        resource: "https://elsewhere.example/mcp",
      })
      expect(await wrongResource.json()).toMatchObject({ error: "invalid_target" })

      const forged = await exchange(app, `${clientId}x`, await authorizationCode(app, clientId))
      expect(forged.status).toBe(400)
      expect(await forged.json()).toMatchObject({ error: "invalid_client" })

      const short = await exchange(app, clientId, await authorizationCode(app, clientId), { code_verifier: "short" })
      expect(await short.json()).toMatchObject({ error: "invalid_request" })

      expect((await status(app)).connections).toHaveLength(1)
    }))

  test("the approval page only opens for a registered client and redirect URI", () =>
    withApp(async (app) => {
      await start(app)
      const clientId = await registered(app)
      const requests = [
        authorization(clientId, { redirect_uri: "https://evil.example/callback" }),
        authorization(`${clientId}x`),
        authorization(clientId, { redirect_uri: `${REDIRECT}/more` }),
      ]
      for (const params of requests) {
        const refused = await get(app, "/oauth/authorize", params)
        expect(refused.status).toBe(400)
        expect(refused.headers.get("location")).toBeNull()
        expect(await refused.text()).toContain("This link does not work")
      }
      expect((await status(app)).requests).toEqual([])
      expect((await get(app, "/oauth/wait", { request: "made-up" })).status).toBe(404)

      const withoutPkce = await get(
        app,
        "/oauth/authorize",
        authorization(clientId, { code_challenge_method: "plain" }),
      )
      expect(withoutPkce.status).toBe(302)
      expect(new URL(withoutPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request")

      const loopback = await registered(app, { redirect_uris: ["http://127.0.0.1:1234/callback"] })
      const anyPort = authorization(loopback, { redirect_uri: "http://127.0.0.1:5678/callback" })
      expect((await get(app, "/oauth/authorize", anyPort)).status).toBe(303)
    }))

  test("registration refuses redirect URIs that are not https or loopback", () =>
    withApp(async (app) => {
      await start(app)
      const refusals = [
        [{ redirect_uris: ["http://chat.example/callback"] }, "invalid_redirect_uri"],
        [{ redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
        [{ redirect_uris: [] }, "invalid_redirect_uri"],
        [{ redirect_uris: Array.from({ length: 6 }, (_, index) => `${REDIRECT}/${index}`) }, "invalid_client_metadata"],
        [{ client_name: "n".repeat(101), redirect_uris: [REDIRECT] }, "invalid_client_metadata"],
        [{ client_name: "No redirects" }, "invalid_client_metadata"],
      ] as const
      for (const [metadata, error] of refusals) {
        const refused = await register(app, metadata)
        expect(refused.status).toBe(400)
        expect(await refused.json()).toMatchObject({ error })
      }
    }))

  test("a removed connection is refused while the others keep working", () =>
    withApp(async (app) => {
      const removed = await connect(app)
      const kept = await connect(app)
      const [first] = (await status(app)).connections
      await app.runtime.runPromise(AppConnections.use((connections) => connections.remove(first!.id)))

      const refused = await fetch(`${app.origin}/mcp`, initialize(removed))
      expect(refused.status).toBe(401)
      expect(refused.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
      )
      expect((await fetch(`${app.origin}/mcp`, initialize())).status).toBe(401)
      expect((await fetch(`${app.origin}/mcp`, initialize(kept))).status).toBe(200)

      const [second] = (await status(app)).connections
      await app.runtime.runPromise(AppConnections.use((connections) => connections.remove(second!.id)))
      expect((await fetch(`${app.origin}/mcp`, initialize(kept))).status).toBe(404)
    }))

  test("every path is 404 until the developer starts connecting or an app is connected", () =>
    withApp(async (app) => {
      expect(await statuses(app)).toEqual(EVERY_PATH.map(() => 404))
      expect((await register(app)).status).toBe(404)

      await start(app)
      expect((await get(app, "/.well-known/oauth-authorization-server")).status).toBe(200)
      expect((await get(app, "/mcp")).status).toBe(401)
      expect((await get(app, "/")).status).toBe(404)

      await linkRelay(app, null)
      expect(await statuses(app)).toEqual(EVERY_PATH.map(() => 404))
    }))
})

const viaListener = (
  port: number,
  host: string,
  path: string,
  { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {},
) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { ...headers, host }, agent: false },
      (response) => {
        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
      },
    )
    request.on("error", reject)
    request.end(body)
  })

const firstFrame = (url: string) =>
  new Promise<{ type: string }>((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.once("error", reject)
    socket.once("message", (raw) => {
      socket.close()
      resolve(JSON.parse(String(raw)) as { type: string })
    })
  })

describe("remote listener", () => {
  test("forwards plain HTTP for the relay hostname to the app server and nothing else", () =>
    withApp(async (app) => {
      const port = await unusedLoopbackPort()
      await app.runtime.runPromise(
        Settings.use((settings) => settings.set({ remote: { enabled: true, bindHost: "127.0.0.1", port } })),
      )
      await vi.waitFor(async () =>
        expect((await app.runtime.runPromise(RemoteAccess.use((remote) => remote.status))).listening).toBe(true),
      )
      await start(app)
      const metadata = "/.well-known/oauth-authorization-server"
      await vi.waitFor(async () => {
        await linkRelay(app)
        expect((await viaListener(port, HOSTNAME, metadata)).status).toBe(200)
      })

      const forwarded = await viaListener(port, `${HOSTNAME.toUpperCase()}:443`, metadata)
      expect(JSON.parse(forwarded.body)).toMatchObject({ issuer: ISSUER })

      for (const host of [`127.0.0.1:${port}`, "other.relay.example", `${HOSTNAME}.evil.example`]) {
        expect(await viaListener(port, host, metadata)).toEqual({ status: 404, body: "" })
      }

      const registration = await viaListener(port, HOSTNAME, "/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "Chat app", redirect_uris: [REDIRECT] }),
      })
      expect(registration.status).toBe(201)
      expect(JSON.parse(registration.body)).toMatchObject({ client_name: "Chat app" })

      const token = await connect(app)
      const initialized = await viaListener(port, HOSTNAME, "/mcp", initialize(token))
      expect(initialized.status).toBe(200)
      expect(initialized.body).toContain('"serverInfo"')
      expect((await viaListener(port, HOSTNAME, "/mcp", initialize())).status).toBe(401)

      expect(await firstFrame(`ws://127.0.0.1:${port}/remote`)).toMatchObject({ type: "challenge" })
    }))
})
