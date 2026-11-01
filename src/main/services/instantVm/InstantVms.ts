import { randomUUID } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { basename, dirname } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { type RpcMethod, RpcMethods, type RpcRequest, type RpcResponse } from "../../../shared/contract.ts"
import { pairingUrl, parsePairingUrl } from "../../../shared/remote.ts"
import { Boat, type BoatClient } from "../boat/Boat.ts"
import { Environments } from "../Environments.ts"
import { Secrets } from "../Secrets.ts"
import { Settings } from "../Settings.ts"
import { encodeTar } from "../tinyVm/tar.ts"

export class InstantVmError extends Schema.TaggedError<InstantVmError>()("InstantVmError", {
  message: Schema.String,
}) {}

export const INSTANT_VM_ENV_SECRET = "instantVm.env"

export interface InstantVm {
  readonly environmentId: string
  readonly name: string
  readonly projectId: string
}

export class InstantVms extends Context.Service<
  InstantVms,
  {
    readonly provision: (repository: string) => Effect.Effect<InstantVm, InstantVmError>
    readonly release: (environmentId: string) => Effect.Effect<void>
  }
>()("hinacode/InstantVms") {}

export interface InstantVmsOptions {
  readonly sandboxesPath: string
  readonly env: Readonly<Record<string, string | undefined>>
}

const SERVE_PORT = 47821
const GUEST_PACKAGE_DIR = "/tmp/hinacode-package"
const PAIR_ATTEMPTS = 30

const Sandboxes = Schema.Record(Schema.String, Schema.String)
const decodeSandboxes = Schema.decodeUnknownOption(Schema.fromJsonString(Sandboxes))

export const parseEnvLines = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split(/\s+/).flatMap((word) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word)
      return match?.[1] === undefined ? [] : [[match[1], match[2] ?? ""]]
    }),
  )

const fail = (message: string) => new InstantVmError({ message })
const failWith = (prefix: string) => (cause: { readonly message: string }) => fail(`${prefix}: ${cause.message}`)

const writeJson = (path: string, value: unknown) =>
  Effect.promise(async () => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  })

const run = (client: BoatClient, id: string, script: string, timeoutSeconds = 120) =>
  client.exec(id, { script, timeoutSeconds }).pipe(
    Effect.mapError(failWith("boat")),
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(Buffer.from(result.stdout).toString("utf8"))
        : Effect.fail(
            fail(
              `The VM failed \`${script.split("\n")[0]}\`: ${Buffer.from(result.stderr).toString("utf8").slice(-800)}`,
            ),
          ),
    ),
  )

const install = (client: BoatClient, id: string, packagePath: string | undefined) =>
  Effect.gen(function* () {
    const local = packagePath
    if (local === undefined || local === "") {
      return yield* run(client, id, "npm install -g --allow-scripts=node-pty hinacode", 600)
    }
    const bytes = yield* Effect.promise(() => readFile(local))
    const tar = encodeTar([{ type: "file", path: basename(local), data: bytes, mode: 0o644, mtime: 0 }])
    yield* client.putFiles(id, GUEST_PACKAGE_DIR, tar).pipe(Effect.mapError(failWith("boat")))
    return yield* run(
      client,
      id,
      `npm install -g --allow-scripts=node-pty ${shellQuote(`${GUEST_PACKAGE_DIR}/${basename(local)}`)}`,
      600,
    )
  })

const guestPairing = (client: BoatClient, id: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < PAIR_ATTEMPTS; attempt++) {
      const printed = yield* run(client, id, "hinacode pair 2>/dev/null || true")
      const pairing = parsePairingUrl(printed)
      if (pairing !== null) return pairing
      yield* Effect.sleep("2 seconds")
    }
    return yield* Effect.fail(fail("hinacode serve on the VM did not print a pairing URL."))
  })

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

const make = (options: InstantVmsOptions) =>
  Effect.gen(function* () {
    const boat = yield* Boat
    const environments = yield* Environments
    const secrets = yield* Secrets
    const settings = yield* Settings

    const readSandboxes = Effect.promise((): Promise<Record<string, string>> =>
      readFile(options.sandboxesPath, "utf8").then(
        (text) => Option.getOrElse(decodeSandboxes(text), (): Record<string, string> => ({})),
        () => ({}),
      ),
    )

    const call = <M extends RpcMethod>(environmentId: string, method: M, payload: RpcRequest<M>) =>
      environments
        .forward(environmentId, { method, payload })
        .pipe(
          Effect.flatMap((envelope) =>
            "error" in envelope
              ? Effect.fail(fail(`${method} failed on the new VM: ${envelope.error.message}`))
              : Schema.decodeUnknownEffect(RpcMethods[method].response)(envelope.result).pipe(
                  Effect.mapError(failWith(`Unexpected answer to ${method}`)),
                ),
          ),
        ) as Effect.Effect<RpcResponse<M>, InstantVmError>

    const linkDeviceHub = (environmentId: string) =>
      Effect.gen(function* () {
        const hub = (yield* settings.get).experimental.deviceHub
        if (hub === null) return
        const pairing = yield* environments.pairingOf(hub)
        if (pairing?.relay == null) return
        yield* call(environmentId, "deviceHub.link", { pairingUrl: pairingUrl(pairing) })
      }).pipe(Effect.catch((error) => Effect.logWarning("instant VM could not link the device hub", error)))

    const provision = (repository: string) =>
      Effect.gen(function* () {
        const [owner, name] = repository.split("/")
        if (owner === undefined || name === undefined)
          return yield* Effect.fail(fail(`${repository} is not owner/name.`))
        const client = yield* boat.client.pipe(Effect.mapError(failWith("boat")))
        const env = parseEnvLines(
          Option.getOrElse(
            yield* secrets.get(INSTANT_VM_ENV_SECRET).pipe(Effect.orElseSucceed(() => Option.none<string>())),
            () => "",
          ),
        )
        const size = (yield* settings.get.pipe(Effect.mapError(failWith("settings")))).experimental.tinyVmBoatSize
        const label = randomUUID().slice(0, 8)
        const { id } = yield* client
          .createSandbox({ type: size, env, name: `hinacode-${label}`, labels: { "hinacode-instant-vm": label } })
          .pipe(Effect.mapError(failWith("boat")))
        const provisioned = Effect.gen(function* () {
          yield* install(client, id, options.env["HINACODE_INSTANT_VM_PACKAGE"])
          yield* client
            .exec(id, {
              script: `HINACODE_SERVE_HOST=127.0.0.1 HINACODE_SERVE_PORT=${SERVE_PORT} HINACODE_SERVE_AUTO_UPDATE=0 hinacode serve`,
              timeoutSeconds: 600,
              detach: true,
            })
            .pipe(Effect.mapError(failWith("boat")))
          const guest = yield* guestPairing(client, id)
          const hosted = new URL(
            yield* client
              .hostPort(id, guest.port, { public: true, localhost: true })
              .pipe(Effect.mapError(failWith("boat"))),
          ).hostname
          const environment = yield* environments
            .add({
              name: `boat-${label}`,
              pairingUrl: pairingUrl({ hosts: [hosted], port: 443, token: guest.token, relay: hosted }),
            })
            .pipe(Effect.mapError(failWith("pairing the VM")))
          yield* writeJson(options.sandboxesPath, { ...(yield* readSandboxes), [environment.id]: id })
          const project = yield* call(environment.id, "projects.clone", {
            repository: { owner, name },
            rootPath: `~/${name}`,
            name,
            setupScript: null,
          })
          yield* linkDeviceHub(environment.id)
          return { environmentId: environment.id, name: environment.name, projectId: project.id }
        })
        return yield* provisioned.pipe(Effect.tapError(() => client.remove(id).pipe(Effect.ignore)))
      })

    const release = (environmentId: string) =>
      Effect.gen(function* () {
        const sandboxes = yield* readSandboxes
        const sandboxId = sandboxes[environmentId]
        if (sandboxId === undefined) return
        const client = yield* boat.client
        yield* client.remove(sandboxId)
        const { [environmentId]: _released, ...rest } = sandboxes
        yield* writeJson(options.sandboxesPath, rest)
      }).pipe(Effect.catch((error) => Effect.logWarning("instant VM release failed", error)))

    return InstantVms.of({ provision, release })
  })

export const layer = (options: InstantVmsOptions) => Layer.effect(InstantVms, make(options))
