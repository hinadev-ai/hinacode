import { readFile } from "node:fs/promises"
import { connect as connectTcp, type Socket } from "node:net"
import { connect as connectTls } from "node:tls"
import { Effect, Redacted, Schema } from "effect"

/** Where the sbx CLI keeps its login. Read on every call, so a new `sbx login` applies at once. */
export interface LoginSource {
  readonly configPath: string
  readonly env: Readonly<Record<string, string | undefined>>
}

export interface SbxLogin {
  readonly url: string
  readonly token: Redacted.Redacted<string>
}

export class SbxNotConfiguredError extends Schema.TaggedError<SbxNotConfiguredError>()("SbxNotConfiguredError", {}) {
  override get message(): string {
    return "No sbx login found. Run `sbx login <url>` or set SBX_URL and SBX_TOKEN."
  }
}

export class SbxError extends Schema.TaggedError<SbxError>()("SbxError", { message: Schema.String }) {}

/** sbxd answered 404 for the sandbox: its idle timeout destroyed it, or someone deleted it. */
export class SandboxGoneError extends Schema.TaggedError<SandboxGoneError>()("SandboxGoneError", {
  id: Schema.String,
}) {
  override get message(): string {
    return "The VM was destroyed (idle timeout or removed). Call the tool again to start a fresh one."
  }
}

const ConfigFile = Schema.fromJsonString(Schema.Struct({ url: Schema.String, token: Schema.String }))
const decodeConfig = Schema.decodeUnknownEffect(ConfigFile)

export const readLogin = (source: LoginSource): Effect.Effect<SbxLogin, SbxNotConfiguredError | SbxError> => {
  const url = source.env["SBX_URL"]
  const token = source.env["SBX_TOKEN"]
  if (url && token) return Effect.succeed({ url, token: Redacted.make(token) })
  return Effect.tryPromise({
    try: () => readFile(source.configPath, "utf8"),
    catch: (cause) =>
      (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? new SbxNotConfiguredError()
        : new SbxError({ message: `Could not read ${source.configPath}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((contents) =>
      decodeConfig(contents).pipe(
        // The schema error would quote the file, token included.
        Effect.mapError(
          () =>
            new SbxError({ message: `${source.configPath} is not a valid sbx login. Run \`sbx login <url>\` again.` }),
        ),
      ),
    ),
    Effect.map((config) => ({ url: config.url, token: Redacted.make(config.token) })),
  )
}

const Sandbox = Schema.Struct({ id: Schema.String })
const Status = Schema.Struct({ sandboxes: Schema.Number, max_sandboxes: Schema.Number })
const TemplateList = Schema.Array(
  Schema.Struct({ name: Schema.String, cpus: Schema.Number, memory_mib: Schema.Number }),
)
const ErrorBody = Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
const ExecExit = Schema.fromJsonString(
  Schema.Struct({
    exit_code: Schema.Number,
    error: Schema.optional(Schema.String),
    pid: Schema.optional(Schema.Number),
    log: Schema.optional(Schema.String),
  }),
)

export interface ExecInput {
  readonly script: string
  /** Seconds before sbx kills the script and reports exit code 124. */
  readonly timeoutSeconds: number
  /** Returns at once with the pid and log path instead of waiting for the script. */
  readonly detach?: boolean | undefined
}

export interface ExecResult {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly exitCode: number
  readonly error?: string | undefined
  readonly pid?: number | undefined
  readonly log?: string | undefined
}

const REQUEST_TIMEOUT_SECONDS = 15
/** File copies move whole archives over the LAN, so they get minutes where API calls get seconds. */
const FILES_TIMEOUT_SECONDS = 300

const STDOUT = 1
const STDERR = 2
const EXIT = 3

/** Splits sbxd's exec stream: frames of a type byte, a big-endian u32 length and the payload. */
const decodeFrames = (body: Buffer) =>
  Effect.gen(function* () {
    const stdout: Array<Buffer> = []
    const stderr: Array<Buffer> = []
    let exit: typeof ExecExit.Type | undefined
    for (let offset = 0; offset < body.length;) {
      if (offset + 5 > body.length) return yield* new SbxError({ message: "sbx sent a truncated exec frame" })
      const type = body[offset]
      const length = body.readUInt32BE(offset + 1)
      const payload = body.subarray(offset + 5, offset + 5 + length)
      offset += 5 + length
      if (type === STDOUT) stdout.push(payload)
      else if (type === STDERR) stderr.push(payload)
      else if (type === EXIT) {
        exit = yield* Schema.decodeUnknownEffect(ExecExit)(payload.toString()).pipe(
          Effect.mapError(() => new SbxError({ message: "sbx sent an exec result HinaCode does not understand" })),
        )
      }
    }
    if (exit === undefined) return yield* new SbxError({ message: "The exec stream ended without an exit code" })
    return {
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: exit.exit_code,
      error: exit.error,
      pid: exit.pid,
      log: exit.log,
    } satisfies ExecResult
  })

const describeCause = (cause: unknown) => {
  if (!(cause instanceof Error)) return String(cause)
  const inner = cause.cause instanceof Error ? `: ${cause.cause.message}` : ""
  return `${cause.message}${inner}`
}

const json =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (response: Response) =>
    Effect.tryPromise({
      try: () => response.json(),
      catch: () => new SbxError({ message: "sbx sent a response that is not JSON" }),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError((error) =>
        error._tag === "SbxError"
          ? error
          : new SbxError({ message: `sbx sent an unexpected response: ${error.message}` }),
      ),
    )

class BodyTooLarge extends Error {}

/** Reads the whole body, giving up as soon as it passes `maxBytes`, so a huge response never sits in memory. */
const readBody = (response: Response, maxBytes = Number.POSITIVE_INFINITY) =>
  Effect.tryPromise({
    try: async () => {
      const chunks: Array<Uint8Array> = []
      let total = 0
      for await (const chunk of response.body ?? []) {
        total += chunk.length
        if (total > maxBytes) throw new BodyTooLarge()
        chunks.push(chunk)
      }
      return Buffer.concat(chunks)
    },
    catch: (cause) =>
      new SbxError({
        message:
          cause instanceof BodyTooLarge
            ? `the archive is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`
            : `The connection to sbx broke: ${describeCause(cause)}`,
      }),
  })

const filesPath = (id: string, guestPath: string) =>
  `/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(guestPath)}`

/** The sbxd HTTP API, as far as hinacode uses it. */
export const sbxClient = (login: SbxLogin) => {
  const base = login.url.replace(/\/+$/, "")
  const authorization = () => `Bearer ${Redacted.value(login.token)}`

  const errorOf = (status: number, body: string, sandboxId: string | undefined) => {
    if (status === 404 && sandboxId !== undefined) return new SandboxGoneError({ id: sandboxId })
    if (status === 401 || status === 403)
      return new SbxError({ message: `The sbx host at ${base} rejected the token. Run \`sbx login ${base}\` again.` })
    const decoded = Schema.decodeUnknownOption(ErrorBody)(body)
    const detail = decoded._tag === "Some" ? decoded.value.error : body.trim() || `HTTP ${status}`
    return new SbxError({ message: `sbx: ${detail}` })
  }

  const request = (
    method: string,
    path: string,
    options: { body?: unknown; sandboxId?: string; contentType?: string } = {},
  ) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`${base}${path}`, {
          method,
          signal,
          headers: {
            authorization: authorization(),
            "content-type": options.contentType ?? "application/json",
          },
          ...(options.body === undefined
            ? {}
            : { body: options.body instanceof Uint8Array ? Buffer.from(options.body) : JSON.stringify(options.body) }),
        }),
      catch: (cause) => new SbxError({ message: `Could not reach sbx at ${base}: ${describeCause(cause)}` }),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(response)
          : Effect.flatMap(
              Effect.promise(() => response.text().catch(() => "")),
              (body) => Effect.fail(errorOf(response.status, body, options.sandboxId)),
            ),
      ),
    )

  const within = (seconds: number) =>
    Effect.timeoutOrElse({
      duration: `${seconds} seconds`,
      orElse: () => Effect.fail(new SbxError({ message: `sbx at ${base} did not answer within ${seconds} s` })),
    })

  const status = request("GET", "/v1/status").pipe(
    Effect.flatMap(json(Status)),
    within(REQUEST_TIMEOUT_SECONDS),
    Effect.map((body) => ({ sandboxes: body.sandboxes, maxSandboxes: body.max_sandboxes })),
  )

  const create = (template: string) =>
    request("POST", "/v1/sandboxes", { body: { template } }).pipe(
      Effect.flatMap(json(Sandbox)),
      within(REQUEST_TIMEOUT_SECONDS),
    )

  /** The templates this host can restore sandboxes from, in the host's order. */
  const templates = request("GET", "/v1/templates").pipe(
    Effect.flatMap(json(TemplateList)),
    within(REQUEST_TIMEOUT_SECONDS),
    Effect.map((list) => list.map((item) => ({ name: item.name, cpus: item.cpus, memoryMiB: item.memory_mib }))),
  )

  const get = (id: string) =>
    request("GET", `/v1/sandboxes/${encodeURIComponent(id)}`, { sandboxId: id }).pipe(
      Effect.flatMap(json(Sandbox)),
      within(REQUEST_TIMEOUT_SECONDS),
    )

  const remove = (id: string) =>
    request("DELETE", `/v1/sandboxes/${encodeURIComponent(id)}`, { sandboxId: id }).pipe(
      Effect.asVoid,
      within(REQUEST_TIMEOUT_SECONDS),
    )

  /**
   * Extracts a tar archive holding one top-level entry into the guest at `guestPath`, which the guest resolves
   * against the desktop user's home when relative. An existing directory keeps the entry's name inside it; a
   * missing path becomes the entry.
   */
  const putFiles = (id: string, guestPath: string, tar: Uint8Array) =>
    request("PUT", filesPath(id, guestPath), { sandboxId: id, body: tar, contentType: "application/x-tar" }).pipe(
      Effect.flatMap(readBody),
      Effect.asVoid,
      within(FILES_TIMEOUT_SECONDS),
    )

  /**
   * Tars the file or directory at `guestPath` in the guest and returns the archive bytes, failing once the
   * archive passes `maxBytes`. A missing path is a 404 too, so it fails as `SandboxGoneError` like a gone sandbox.
   */
  const getFiles = (id: string, guestPath: string, maxBytes?: number) =>
    request("GET", filesPath(id, guestPath), { sandboxId: id }).pipe(
      Effect.flatMap((response) => readBody(response, maxBytes)),
      within(FILES_TIMEOUT_SECONDS),
    )

  const exec = (id: string, input: ExecInput) =>
    request("POST", `/v1/sandboxes/${encodeURIComponent(id)}/exec`, {
      sandboxId: id,
      body: {
        script: input.script,
        timeout: `${input.timeoutSeconds}s`,
        ...(input.detach ? { detach: true } : {}),
      },
    }).pipe(
      Effect.flatMap(readBody),
      // sbx enforces the script's timeout; this one only catches a host that stopped answering.
      within(input.timeoutSeconds + REQUEST_TIMEOUT_SECONDS),
      Effect.flatMap(decodeFrames),
    )

  /**
   * Opens a raw TCP stream to `port` in the guest through sbxd's `Upgrade: tcp` endpoint. `head` holds
   * guest bytes that arrived with the 101 response. `passive` connections do not count as activity for
   * the idle timeout.
   */
  const tunnel = (id: string, port: number, options: { readonly passive?: boolean } = {}) =>
    Effect.callback<{ readonly socket: Socket; readonly head: Uint8Array }, SbxError | SandboxGoneError>((resume) => {
      const url = new URL(base)
      const secure = url.protocol === "https:"
      const hostPort = Number(url.port || (secure ? 443 : 80))
      const query = `port=${port}${options.passive ? "&passive=1" : ""}`
      const path = `${url.pathname.replace(/\/+$/, "")}/v1/sandboxes/${encodeURIComponent(id)}/tcp?${query}`
      const onConnect = () =>
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: ${authorization()}\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n`,
        )
      const socket = secure
        ? connectTls({ host: url.hostname, port: hostPort, servername: url.hostname }, onConnect)
        : connectTcp({ host: url.hostname, port: hostPort }, onConnect)
      socket.setNoDelay(true)
      let received = Buffer.alloc(0)
      const timer = setTimeout(
        () => fail(new SbxError({ message: `sbx at ${base} did not answer within 10 s` })),
        10_000,
      )
      const cleanup = () => {
        clearTimeout(timer)
        socket.off("data", onData)
        socket.off("error", onError)
        socket.off("close", onClose)
      }
      const fail = (error: SbxError | SandboxGoneError) => {
        cleanup()
        socket.destroy()
        resume(Effect.fail(error))
      }
      const onData = (chunk: Buffer) => {
        received = Buffer.concat([received, chunk])
        const end = received.indexOf("\r\n\r\n")
        if (end < 0) return
        const statusLine = received.subarray(0, received.indexOf("\r\n")).toString()
        const code = Number(statusLine.split(" ")[1])
        if (code !== 101) return fail(errorOf(code, received.subarray(end + 4).toString(), id))
        cleanup()
        resume(Effect.succeed({ socket, head: received.subarray(end + 4) }))
      }
      const onError = (cause: Error) =>
        fail(new SbxError({ message: `Could not reach sbx at ${base}: ${describeCause(cause)}` }))
      const onClose = () => fail(new SbxError({ message: `sbx at ${base} closed the connection` }))
      socket.on("data", onData)
      socket.on("error", onError)
      socket.on("close", onClose)
      return Effect.sync(() => {
        cleanup()
        socket.destroy()
      })
    })

  return { url: base, status, create, templates, get, remove, exec, tunnel, putFiles, getFiles }
}

export type SbxClient = ReturnType<typeof sbxClient>
