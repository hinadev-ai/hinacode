import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { isSea } from "node:sea"
import { Effect, Option } from "effect"
import { Command, Flag } from "effect/cli"
import { CliFailure, EXIT } from "./exit.ts"
import { connect, disconnect, serveProgram, type ServiceHost } from "./service.ts"
import { DataDir } from "./session.ts"

const cloudData = Effect.gen(function* () {
  const flag = Option.getOrUndefined(yield* DataDir)
  return flag ?? (process.env["HINACODE_USER_DATA"] || join(homedir(), ".hinacode-cloud"))
})

const failure = (command: string) => (error: unknown) =>
  new CliFailure({
    code: EXIT.failed,
    message: `${command}: ${error instanceof Error ? error.message : String(error)}`,
  })

const serviceHost = (): ServiceHost => ({
  platform: process.platform,
  home: homedir(),
  uid: userInfo().uid,
  env: process.env,
})

const runDaemon = (command: string, start: (daemon: typeof import("../main/daemon.ts")) => Promise<void>) =>
  Effect.tryPromise({
    try: () => import("../main/daemon.ts").then(start),
    catch: failure(command),
  })

const serve = Command.make(
  "serve",
  {
    port: Flag.Int("port").pipe(
      Flag.withMetavar("n"),
      Flag.withDescription("Port to listen on, or HINACODE_SERVE_PORT."),
      Flag.optional,
    ),
    host: Flag.String("host").pipe(
      Flag.withMetavar("host"),
      Flag.withDescription(
        "Address to bind, or HINACODE_SERVE_HOST. Defaults to private, every private-network address of this machine. Use 127.0.0.1 to reach the cloud only through the relay.",
      ),
      Flag.optional,
    ),
    rotateToken: Flag.Boolean("rotate-token").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Replace the token, which unpairs every client, or HINACODE_SERVE_ROTATE_TOKEN=1."),
    ),
    relay: Flag.Boolean("relay").pipe(
      Flag.withDescription(
        "Reach the cloud from any network through the HinaCode relay, or HINACODE_SERVE_RELAY. --relay prints a URL to sign in and link it to your HinaCode account. --no-relay removes it.",
      ),
      Flag.optional,
    ),
  },
  (flags) =>
    Effect.flatMap(cloudData, (userData) =>
      runDaemon("serve", (daemon) =>
        daemon.serve(
          {
            port: Option.getOrUndefined(flags.port),
            host: Option.getOrUndefined(flags.host),
            relay: Option.getOrUndefined(Option.map(flags.relay, (on) => (on ? "on" : "off"))),
            rotateToken: flags.rotateToken,
          },
          userData,
        ),
      ),
    ),
).pipe(
  Command.withShortDescription("Run a HinaCode cloud on this machine."),
  Command.withDescription(
    "Run a HinaCode cloud: agents, worktrees and threads on this machine, driven from the desktop or phone app. A cloud installed with npm install -g installs new releases on its own once nothing is running; set HINACODE_SERVE_AUTO_UPDATE=0 to update it by hand. Data lives in HINACODE_USER_DATA, default ~/.hinacode-cloud.",
  ),
)

const pair = Command.make("pair", {}, () =>
  Effect.flatMap(cloudData, (userData) => runDaemon("pair", (daemon) => daemon.pair(userData))),
).pipe(Command.withDescription("Print the pairing URLs and QR code of the cloud again, without restarting it."))

const connectCommand = Command.make("connect", {}, () =>
  Effect.gen(function* () {
    const customDataDir = Option.isSome(yield* DataDir) || Boolean(process.env["HINACODE_USER_DATA"])
    const userData = yield* cloudData
    yield* Effect.tryPromise({
      try: async () =>
        connect({
          host: serviceHost(),
          program: serveProgram(process, isSea()),
          userData,
          customDataDir,
          pairingText: (await import("../main/daemon.ts")).readPairingText,
        }),
      catch: failure("connect"),
    })
  }),
).pipe(
  Command.withShortDescription("Keep a HinaCode cloud running on this machine."),
  Command.withDescription(
    "Run hinacode serve as a launchd agent on macOS or a systemd user service on Linux, so it starts at boot and restarts if it stops, then print its pairing URLs. Run it again after an update to restart the service.",
  ),
)

const disconnectCommand = Command.make("disconnect", {}, () =>
  Effect.try({ try: () => disconnect(serviceHost()), catch: failure("disconnect") }),
).pipe(Command.withDescription("Stop the service hinacode connect installed and remove it. The cloud's data stays."))

export const cloudCommands = [serve, pair, connectCommand, disconnectCommand] as const
