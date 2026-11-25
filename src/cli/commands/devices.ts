import { Effect, Result } from "effect"
import { Argument, Command } from "effect/cli"
import { RpcMethods } from "../../shared/contract.ts"
import type { RemoteDevice } from "../../shared/domain.ts"
import { type CliFailure, usageError } from "../exit.ts"
import { emit, encode, succeed, withClient } from "../session.ts"

const MIN_KEY_PREFIX = 4

export const resolveDevice = (
  raw: string,
  devices: ReadonlyArray<RemoteDevice>,
): Result.Result<RemoteDevice, CliFailure> => {
  const named = devices.filter((device) => device.name.toLowerCase() === raw.toLowerCase())
  const matches =
    named.length > 0 || raw.length < MIN_KEY_PREFIX ? named : devices.filter((device) => device.key.startsWith(raw))
  if (matches.length === 1) return Result.succeed(matches[0]!)
  if (matches.length === 0)
    return Result.fail(usageError(`no device is named ${raw} or has a key starting with it. Run hinacode devices.`))
  return Result.fail(
    usageError(
      [
        `${raw} matches more than one device. Pass more of its key:`,
        ...matches.map((device) => `  ${device.key.slice(0, 12)}  ${device.name}`),
      ].join("\n"),
    ),
  )
}

const approve = Command.make(
  "approve",
  { code: Argument.String("code").pipe(Argument.withDescription("The code the waiting device shows, like K7Q-F2M.")) },
  ({ code }) =>
    emit(
      withClient((client) =>
        Effect.gen(function* () {
          const device = yield* client.call("remote.devices.approve", { code })
          return succeed(yield* encode(RpcMethods["remote.devices.approve"].response, device))
        }),
      ),
    ),
).pipe(Command.withDescription("Trust the waiting device that shows this code."))

const remove = Command.make(
  "remove",
  {
    device: Argument.String("device").pipe(
      Argument.withDescription(`A device's name, or ${MIN_KEY_PREFIX}+ characters of its key.`),
    ),
  },
  (args) =>
    emit(
      withClient((client) =>
        Effect.gen(function* () {
          const { devices } = yield* client.call("remote.devices", undefined)
          const device = yield* Effect.fromResult(resolveDevice(args.device, devices))
          yield* client.call("remote.devices.remove", { key: device.key })
          return succeed({ key: device.key, name: device.name })
        }),
      ),
    ),
).pipe(Command.withDescription("Stop trusting a device and end its sessions. It must pair again."))

export const devices = Command.make("devices", {}, () =>
  emit(
    withClient((client) =>
      Effect.gen(function* () {
        const listed = yield* client.call("remote.devices", undefined)
        return succeed(yield* encode(RpcMethods["remote.devices"].response, listed))
      }),
    ),
  ),
).pipe(
  Command.withDescription(
    "List the devices this machine trusts and how many wait for approval. Approve one with the code it shows, or remove one.",
  ),
  Command.withSubcommands([approve, remove]),
)
