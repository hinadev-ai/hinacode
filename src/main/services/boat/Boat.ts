import { randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Secrets } from "../Secrets.ts"
import { SandboxGoneError, type ExecInput, type ExecResult } from "../tinyVm/sbx.ts"

export const BOAT_API_KEY_SECRET = "boat.apiKey"

export class BoatError extends Schema.TaggedError<BoatError>()("BoatError", { message: Schema.String }) {}

export class BoatNotConfiguredError extends Schema.TaggedError<BoatNotConfiguredError>()("BoatNotConfiguredError", {}) {
  override get message(): string {
    return "No boat API key. Add one in Settings > Experimental, or set BOAT_API_KEY."
  }
}

export class BoatSnapshotExpiredError extends Schema.TaggedError<BoatSnapshotExpiredError>()(
  "BoatSnapshotExpiredError",
  {},
) {
  override get message(): string {
    return "The stored boat snapshot has expired."
  }
}

export { SandboxGoneError }

export interface BoatSandbox {
  readonly id: string
  readonly name: string
  readonly state: string
  readonly labels: Readonly<Record<string, string>>
}

export const BOAT_READY_STATES = ["ready", "idle", "running"] as const

const REQUEST_TIMEOUT_SECONDS = 15
const FILES_TIMEOUT_SECONDS = 300
const WAIT_READY_POLL_SECONDS = 2
const WAIT_READY_MAX_ATTEMPTS = 120
const DESKTOP_MAX_ATTEMPTS = 5
const DEFAULT_TTL_SECONDS = 7200
const SIGNED_URL_TTL_SECONDS = 900
const BOAT_SIZES = ["small", "default", "large", "xlarge"] as const

const SandboxObject = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
})

const CreateResponse = Schema.Struct({ sandbox: Schema.Struct({ id: Schema.String }) })

const GetSandboxResponse = Schema.Struct({
  sandbox: Schema.optional(SandboxObject),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
})

const ListResponse = Schema.Struct({
  sandboxes: Schema.Array(SandboxObject),
  pageInfo: Schema.optional(
    Schema.Struct({
      hasMore: Schema.optional(Schema.Boolean),
      nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

const CommandResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
})

const CommandStartedResponse = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  pid: Schema.optional(Schema.Number),
  processId: Schema.optional(Schema.Number),
  logPath: Schema.optional(Schema.String),
})

const FileUrlResponse = Schema.Struct({
  url: Schema.String,
  method: Schema.optional(Schema.String),
})

const DesktopResponse = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  desktopUrl: Schema.optional(Schema.NullOr(Schema.String)),
  provisioning: Schema.optional(Schema.Boolean),
  message: Schema.optional(Schema.String),
})

const HostResponse = Schema.Struct({ url: Schema.String })

const LimitsResponse = Schema.Struct({
  canStart: Schema.Boolean,
  currentLimits: Schema.optional(Schema.Struct({ activeSandboxes: Schema.optional(Schema.Number) })),
})

const ErrorEnvelope = Schema.Struct({
  ok: Schema.optional(Schema.Boolean),
  type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      status: Schema.optional(Schema.Number),
      details: Schema.optional(Schema.Unknown),
    }),
  ),
  requestId: Schema.optional(Schema.String),
})

const decodeErrorEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorEnvelope))

const describeCause = (cause: unknown) => {
  if (!(cause instanceof Error)) return String(cause)
  const inner = cause.cause instanceof Error ? `: ${cause.cause.message}` : ""
  return `${cause.message}${inner}`
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const resolveGuestPath = (guestPath: string) => {
  if (guestPath.startsWith("/")) return guestPath
  if (guestPath === "~") return "/home/user"
  if (guestPath.startsWith("~/")) return `/home/user/${guestPath.slice(2)}`
  if (guestPath.startsWith("./")) return `/home/user/${guestPath.slice(2)}`
  return `/home/user/${guestPath}`
}

const withOverlayZero = (desktopUrl: string) => {
  const hashIndex = desktopUrl.indexOf("#")
  const before = hashIndex >= 0 ? desktopUrl.slice(0, hashIndex) : desktopUrl
  const fragment = hashIndex >= 0 ? desktopUrl.slice(hashIndex) : ""
  if (/[?&]overlay=/.test(before)) return desktopUrl
  const separator = before.includes("?") ? "&" : "?"
  return `${before}${separator}overlay=0${fragment}`
}

const toBoatSandbox = (value: typeof SandboxObject.Type): BoatSandbox => ({
  id: value.id,
  name: value.name ?? "",
  state: value.state ?? value.status ?? "",
  labels: value.labels ?? {},
})

const clampTimeout = (seconds: number) => Math.min(600, Math.max(1, Math.round(seconds)))

const sandboxPath = (id: string, suffix = "") => `/sandboxes/${encodeURIComponent(id)}${suffix}`

const safeCode = (code: string | undefined) => (code !== undefined && /^[a-z0-9_]{1,64}$/.test(code) ? code : "unknown")

const safeRequestId = (requestId: string | undefined) =>
  requestId !== undefined && /^req_[A-Za-z0-9]{8,64}$/.test(requestId) ? requestId : undefined

const BILLING_CODES = new Set([
  "trial_billing_required",
  "billing_required",
  "payment_required",
  "insufficient_credits",
  "account_frozen",
  "subscription_required",
])

const errorOf = (status: number, body: string, sandboxId: string | undefined) => {
  const decoded = decodeErrorEnvelope(body)
  const envelope = decoded._tag === "Some" ? decoded.value : undefined
  const rawCode = envelope?.code ?? envelope?.error?.code
  const code = safeCode(rawCode)
  const requestId = safeRequestId(envelope?.requestId)
  const suffix = requestId === undefined ? "" : ` (request ${requestId})`
  if (status === 404 && sandboxId !== undefined) return new SandboxGoneError({ id: sandboxId })
  if (status === 409 && rawCode === "snapshot_data_expired") return new BoatSnapshotExpiredError()
  if (status === 401)
    return new BoatError({ message: "boat rejected the API key. Replace it in Settings > Experimental." })
  if (status === 402 || (rawCode !== undefined && BILLING_CODES.has(rawCode)))
    return new BoatError({
      message: `boat billing needs attention before it starts sandboxes. Add a payment method or top up at boat.dev, then try again.${suffix}`,
    })
  if (
    status === 409 &&
    sandboxId !== undefined &&
    (rawCode === "machine_not_running" || rawCode === "sandbox_not_ready")
  )
    return new SandboxGoneError({ id: sandboxId })
  if (status === 429)
    return new BoatError({ message: `boat rate limited the request. Wait a moment and try again.${suffix}` })
  if (status >= 500) return new BoatError({ message: `boat is unavailable right now (HTTP ${status}).${suffix}` })
  return new BoatError({ message: `boat: request failed (HTTP ${status}, code ${code}).${suffix}` })
}

export const boatClient = (input: { readonly baseUrl: string; readonly apiKey: Redacted.Redacted<string> }) => {
  const base = input.baseUrl.replace(/\/+$/, "")
  const authorization = () => `Bearer ${Redacted.value(input.apiKey)}`

  const request = (
    method: string,
    path: string,
    options: {
      readonly body?: unknown
      readonly sandboxId?: string
      readonly headers?: Readonly<Record<string, string>>
    } = {},
  ) =>
    Effect.tryPromise({
      try: (signal) =>
        fetch(`${base}${path}`, {
          method,
          signal,
          headers: {
            authorization: authorization(),
            "content-type": "application/json",
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      catch: (cause: unknown) => new BoatError({ message: `Could not reach boat at ${base}: ${describeCause(cause)}` }),
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
      orElse: () => Effect.fail(new BoatError({ message: `boat at ${base} did not answer within ${seconds} s` })),
    })

  const jsonRequest = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    endpoint: string,
    method: string,
    path: string,
    options: {
      readonly body?: unknown
      readonly sandboxId?: string
      readonly headers?: Readonly<Record<string, string>>
    } = {},
  ) =>
    request(method, path, options).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: () => new BoatError({ message: `boat sent an unexpected response from ${endpoint}` }),
        }),
      ),
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => new BoatError({ message: `boat sent an unexpected response from ${endpoint}` })),
        ),
      ),
    )

  const getSandbox = (id: string) =>
    jsonRequest(GetSandboxResponse, "GET /sandboxes/{id}", "GET", sandboxPath(id), { sandboxId: id }).pipe(
      Effect.flatMap((response) => {
        const found =
          response.sandbox ??
          (response.id !== undefined
            ? {
                id: response.id,
                name: response.name,
                state: response.state,
                status: response.status,
                labels: response.labels,
              }
            : undefined)
        if (found === undefined)
          return Effect.fail(new BoatError({ message: "boat sent an unexpected response from GET /sandboxes/{id}" }))
        return Effect.succeed(toBoatSandbox(found))
      }),
      within(REQUEST_TIMEOUT_SECONDS),
    )

  const waitReady = (id: string) => {
    const poll = (
      attempt: number,
    ): Effect.Effect<{ readonly id: string }, BoatError | SandboxGoneError | BoatSnapshotExpiredError> =>
      Effect.flatMap(getSandbox(id), (sandbox) => {
        if ((BOAT_READY_STATES as ReadonlyArray<string>).includes(sandbox.state)) return Effect.succeed({ id })
        if (sandbox.state === "cancelled") return Effect.fail(new SandboxGoneError({ id }))
        if (sandbox.state === "error")
          return Effect.fail(new BoatError({ message: `boat sandbox ${id} entered state error` }))
        if (attempt >= WAIT_READY_MAX_ATTEMPTS)
          return Effect.fail(
            new BoatError({ message: `boat sandbox ${id} did not become ready; last state is ${sandbox.state}` }),
          )
        return Effect.sleep(`${WAIT_READY_POLL_SECONDS} seconds`).pipe(Effect.andThen(poll(attempt + 1)))
      })
    return poll(1)
  }

  const rawCommand = (id: string, command: string, timeoutSeconds = 120) =>
    jsonRequest(CommandResponse, "POST /sandboxes/{id}/commands", "POST", sandboxPath(id, "/commands"), {
      sandboxId: id,
      body: { command, timeoutSeconds: clampTimeout(timeoutSeconds) },
    }).pipe(
      within(clampTimeout(timeoutSeconds) + REQUEST_TIMEOUT_SECONDS),
      Effect.map((response) => ({
        stdout: response.stdout ?? response.output ?? "",
        stderr: response.stderr ?? "",
        exitCode: response.timedOut ? 124 : (response.exitCode ?? (response.success === false ? -1 : 0)),
        timedOut: response.timedOut ?? false,
        success: response.success,
      })),
    )

  const readFileBytes = (id: string, guestPath: string) =>
    jsonRequest(
      FileUrlResponse,
      "POST /sandboxes/{id}/files/download-url",
      "POST",
      sandboxPath(id, "/files/download-url"),
      { sandboxId: id, body: { path: guestPath, ttlSeconds: SIGNED_URL_TTL_SECONDS } },
    ).pipe(
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.flatMap(({ url }) =>
        Effect.tryPromise({
          try: (signal) => fetch(url, { method: "GET", signal }),
          catch: () => new BoatError({ message: "boat file download failed" }),
        }).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.tryPromise({
                  try: () => response.arrayBuffer(),
                  catch: () => new BoatError({ message: "boat file download failed" }),
                }).pipe(Effect.map((buffer) => Buffer.from(buffer)))
              : Effect.fail(new BoatError({ message: `boat file download failed with HTTP ${response.status}` })),
          ),
          within(FILES_TIMEOUT_SECONDS),
        ),
      ),
    )

  const writeFileBytes = (id: string, guestPath: string, bytes: Uint8Array) =>
    jsonRequest(
      FileUrlResponse,
      "POST /sandboxes/{id}/files/upload-url",
      "POST",
      sandboxPath(id, "/files/upload-url"),
      { sandboxId: id, body: { path: guestPath, ttlSeconds: SIGNED_URL_TTL_SECONDS } },
    ).pipe(
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.flatMap(({ url, method }) =>
        Effect.tryPromise({
          try: (signal) => fetch(url, { method: method ?? "PUT", signal, body: Buffer.from(bytes) }),
          catch: () => new BoatError({ message: "boat file upload failed" }),
        }).pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.void
              : Effect.fail(new BoatError({ message: `boat file upload failed with HTTP ${response.status}` })),
          ),
          within(FILES_TIMEOUT_SECONDS),
        ),
      ),
    )

  const cleanupGuestFiles = (id: string, paths: ReadonlyArray<string>) =>
    rawCommand(id, `rm -f ${paths.map(shellQuote).join(" ")}`, REQUEST_TIMEOUT_SECONDS).pipe(
      Effect.catch(() => Effect.succeed({ stdout: "", stderr: "", exitCode: 0, timedOut: false, success: true })),
      Effect.asVoid,
    )

  const createSandbox = (options: {
    readonly type: string
    readonly env?: Readonly<Record<string, string>>
    readonly name?: string
    readonly labels?: Readonly<Record<string, string>>
  }) => {
    const type = (BOAT_SIZES as ReadonlyArray<string>).includes(options.type) ? options.type : "default"
    return jsonRequest(CreateResponse, "POST /sandboxes", "POST", "/sandboxes", {
      body: {
        type,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        env: options.env ?? {},
        labels: { hinacode: "1", ...options.labels },
        ...(options.name !== undefined ? { name: options.name } : {}),
      },
      headers: { "Idempotency-Key": randomUUID() },
    }).pipe(
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.flatMap(({ sandbox }) => waitReady(sandbox.id)),
    )
  }

  const create = (template: string, env: Readonly<Record<string, string>> = {}) =>
    createSandbox({ type: template, env })

  const get = (id: string) =>
    Effect.flatMap(getSandbox(id), (sandbox) =>
      sandbox.state === "cancelled" ? Effect.fail(new SandboxGoneError({ id })) : Effect.succeed({ id: sandbox.id }),
    )

  const remove = (id: string) =>
    request("DELETE", sandboxPath(id), {
      sandboxId: id,
      headers: { "X-Ascii-Confirm-Delete": id },
    }).pipe(
      Effect.asVoid,
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.catchTag("SandboxGoneError", () => Effect.void),
    )

  const stop = (id: string) =>
    request("POST", sandboxPath(id, "/stop"), { sandboxId: id, body: {} }).pipe(
      Effect.asVoid,
      within(REQUEST_TIMEOUT_SECONDS),
    )

  const resume = (id: string) =>
    request("POST", sandboxPath(id, "/resume"), {
      sandboxId: id,
      body: { ttlSeconds: DEFAULT_TTL_SECONDS },
    }).pipe(Effect.asVoid, within(REQUEST_TIMEOUT_SECONDS), Effect.andThen(waitReady(id)))

  const execDetached = (id: string, execInput: ExecInput) =>
    jsonRequest(CommandStartedResponse, "POST /sandboxes/{id}/commands", "POST", sandboxPath(id, "/commands"), {
      sandboxId: id,
      body: { command: `DISPLAY=:0 bash -lc ${shellQuote(execInput.script)}`, detached: true },
    }).pipe(
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.flatMap((response) => {
        const pid = response.pid ?? response.processId
        if (pid === undefined)
          return Effect.fail(
            new BoatError({ message: "boat: POST /sandboxes/{id}/commands answered without a process id" }),
          )
        return Effect.succeed({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: response.success === false ? -1 : 0,
          pid,
          log: response.logPath,
        } satisfies ExecResult)
      }),
    )

  const execSync = (id: string, execInput: ExecInput) =>
    Effect.gen(function* () {
      const token = randomUUID()
      const outPath = `/tmp/.hinacode-${token}.out`
      const errPath = `/tmp/.hinacode-${token}.err`
      const command = `DISPLAY=:0 bash -lc ${shellQuote(execInput.script)} >${shellQuote(outPath)} 2>${shellQuote(errPath)}`
      const result = yield* rawCommand(id, command, execInput.timeoutSeconds)
      const stdout = yield* readFileBytes(id, outPath)
      const stderr = yield* readFileBytes(id, errPath)
      yield* cleanupGuestFiles(id, [outPath, errPath])
      return {
        stdout,
        stderr,
        exitCode: result.timedOut ? 124 : result.exitCode,
      } satisfies ExecResult
    })

  const exec = (
    id: string,
    execInput: ExecInput,
  ): Effect.Effect<ExecResult, BoatError | SandboxGoneError | BoatSnapshotExpiredError> =>
    execInput.detach ? execDetached(id, execInput) : execSync(id, execInput)

  const putFiles = (id: string, guestPath: string, tar: Uint8Array) =>
    Effect.gen(function* () {
      const resolved = resolveGuestPath(guestPath)
      const tmpPath = `/tmp/.hinacode-${randomUUID()}.tar`
      yield* writeFileBytes(id, tmpPath, tar)
      const command = `mkdir -p ${shellQuote(resolved)} && tar -xf ${shellQuote(tmpPath)} -C ${shellQuote(resolved)}; rc=$?; rm -f ${shellQuote(tmpPath)}; exit $rc`
      const result = yield* rawCommand(id, command)
      if (result.exitCode !== 0)
        return yield* Effect.fail(
          new BoatError({
            message: `boat: failed to extract files in sandbox: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
          }),
        )
    })

  const getFiles = (id: string, guestPath: string, maxBytes?: number) =>
    Effect.gen(function* () {
      const resolved = resolveGuestPath(guestPath).replace(/\/+$/, "") || "/"
      const slashIndex = resolved.lastIndexOf("/")
      const parent = slashIndex <= 0 ? "/" : resolved.slice(0, slashIndex)
      const baseName = resolved.slice(slashIndex + 1)
      if (baseName.length === 0)
        return yield* Effect.fail(new BoatError({ message: `boat: cannot download ${guestPath}` }))
      const tmpPath = `/tmp/.hinacode-${randomUUID()}.tar`
      const command = `tar -cf ${shellQuote(tmpPath)} -C ${shellQuote(parent)} ${shellQuote(baseName)} && stat -c%s ${shellQuote(tmpPath)}`
      const result = yield* rawCommand(id, command)
      if (result.exitCode !== 0) {
        yield* cleanupGuestFiles(id, [tmpPath])
        return yield* Effect.fail(
          new BoatError({
            message: `boat: failed to archive files in sandbox: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`,
          }),
        )
      }
      const sizeText = result.stdout.trim().split(/\s+/).filter(Boolean).pop() ?? ""
      const size = Number(sizeText)
      if (!Number.isFinite(size)) {
        yield* cleanupGuestFiles(id, [tmpPath])
        return yield* Effect.fail(
          new BoatError({ message: "boat sent an unexpected response from POST /sandboxes/{id}/commands" }),
        )
      }
      if (maxBytes !== undefined && size > maxBytes) {
        yield* cleanupGuestFiles(id, [tmpPath])
        return yield* Effect.fail(
          new BoatError({ message: `the archive is larger than ${Math.round(maxBytes / 1024 / 1024)} MB` }),
        )
      }
      const bytes = yield* readFileBytes(id, tmpPath)
      yield* cleanupGuestFiles(id, [tmpPath])
      return bytes
    })

  const desktopUrl = (id: string) => {
    const attempt = (
      remaining: number,
    ): Effect.Effect<string, BoatError | SandboxGoneError | BoatSnapshotExpiredError> =>
      jsonRequest(DesktopResponse, "POST /sandboxes/{id}/desktop", "POST", sandboxPath(id, "/desktop"), {
        sandboxId: id,
        body: {},
      }).pipe(
        within(REQUEST_TIMEOUT_SECONDS),
        Effect.flatMap((response) => {
          const candidate = response.desktopUrl ?? ""
          if (response.provisioning !== true && candidate.length > 0) return Effect.succeed(withOverlayZero(candidate))
          if (remaining <= 1)
            return Effect.fail(new BoatError({ message: "boat desktop is still provisioning. Try again in a moment." }))
          return Effect.sleep(`${WAIT_READY_POLL_SECONDS} seconds`).pipe(Effect.andThen(attempt(remaining - 1)))
        }),
      )
    return attempt(DESKTOP_MAX_ATTEMPTS)
  }

  const hostPort = (id: string, port: number) =>
    jsonRequest(HostResponse, "POST /sandboxes/{id}/host", "POST", sandboxPath(id, "/host"), {
      sandboxId: id,
      body: { port },
    }).pipe(
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.map(({ url }) => url),
    )

  const limits = () =>
    jsonRequest(LimitsResponse, "GET /limits", "GET", "/limits").pipe(
      within(REQUEST_TIMEOUT_SECONDS),
      Effect.map((response) => ({
        canStart: response.canStart,
        maxSandboxes: response.currentLimits?.activeSandboxes ?? 0,
      })),
    )

  const listAll = () =>
    Effect.gen(function* () {
      const all: Array<BoatSandbox> = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const query = cursor === undefined ? "limit=200" : `limit=200&cursor=${encodeURIComponent(cursor)}`
        const response = yield* jsonRequest(ListResponse, "GET /sandboxes", "GET", `/sandboxes?${query}`).pipe(
          within(REQUEST_TIMEOUT_SECONDS),
        )
        all.push(...response.sandboxes.map(toBoatSandbox))
        const next = response.pageInfo?.nextCursor ?? undefined
        if (response.pageInfo?.hasMore !== true || next === undefined || next === "") break
        cursor = next
      }
      return all
    })

  const status = Effect.gen(function* () {
    const lim = yield* limits()
    const all = yield* listAll()
    const sandboxes = all.filter((sandbox) =>
      ["ready", "idle", "running", "provisioning"].includes(sandbox.state),
    ).length
    return { sandboxes, maxSandboxes: lim.maxSandboxes || sandboxes }
  })

  const templates = Effect.succeed([
    { name: "small", cpus: 2, memoryMiB: 4096 },
    { name: "default", cpus: 4, memoryMiB: 8192 },
    { name: "large", cpus: 8, memoryMiB: 16384 },
    { name: "xlarge", cpus: 16, memoryMiB: 32768 },
  ])

  return {
    url: base,
    status,
    create,
    createSandbox,
    templates,
    get,
    remove,
    exec,
    putFiles,
    getFiles,
    stop,
    resume,
    desktopUrl,
    hostPort,
    listAll,
    readFileBytes,
    limits,
    getSandbox,
    waitReady,
  }
}

export type BoatClient = ReturnType<typeof boatClient>

export class Boat extends Context.Service<
  Boat,
  {
    readonly client: Effect.Effect<BoatClient, BoatNotConfiguredError | BoatError>
    readonly configured: Effect.Effect<boolean>
  }
>()("hinacode/Boat") {}

const make = (env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const secrets = yield* Secrets

    const resolveApiKey: Effect.Effect<string, BoatNotConfiguredError | BoatError> = (() => {
      const fromEnv = env["BOAT_API_KEY"]
      if (fromEnv !== undefined && fromEnv.length > 0) return Effect.succeed(fromEnv)
      return secrets.get(BOAT_API_KEY_SECRET).pipe(
        Effect.mapError((error) => new BoatError({ message: error.message })),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new BoatNotConfiguredError()),
            onSome: (value: string) =>
              value.length > 0 ? Effect.succeed(value) : Effect.fail(new BoatNotConfiguredError()),
          }),
        ),
      )
    })()

    const baseUrlRaw = env["BOAT_API_BASE"]
    const baseUrl = baseUrlRaw !== undefined && baseUrlRaw.length > 0 ? baseUrlRaw : "https://boat.dev/api/v1"

    const client = Effect.map(resolveApiKey, (apiKey) => boatClient({ baseUrl, apiKey: Redacted.make(apiKey) }))

    const configured = Effect.match(resolveApiKey, {
      onFailure: () => false,
      onSuccess: () => true,
    })

    return Boat.of({ client, configured })
  })

export const layer = (env: Readonly<Record<string, string | undefined>>) => Layer.effect(Boat, make(env))
