import { Context, Effect, Layer, Schema } from "effect"
import { type RpcEnvelope, RpcMethods, type RpcRequest, type RpcResponse } from "../../shared/contract.ts"
import type { AskableMethod, ServerFrame } from "../../shared/remote.ts"
import { routes } from "../../shared/routes.ts"
import { Environments } from "../services/Environments.ts"

const ASK_TIMEOUT = "15 seconds"

export interface PeerError {
  readonly message: string
}

export type AskFrame = Extract<ServerFrame, { type: "ask" }>

/** A desktop that sent `hub` to this machine's remote listener. */
export interface Hub {
  readonly answer: (id: number, envelope: RpcEnvelope<unknown>) => void
  readonly leave: () => void
}

/** The user's other machines, for the MCP tools that read threads. See `docs/features/2026-10-26-cross-machine-threads.md`. */
export class Peers extends Context.Service<
  Peers,
  {
    /**
     * Runs a read through a desktop connected to this machine, which answers for itself and every cloud it reaches,
     * or else on this desktop's own clouds. An answer can include this machine's own rows.
     */
    readonly ask: <M extends AskableMethod>(
      method: M,
      payload: RpcRequest<M>,
    ) => Effect.Effect<RpcResponse<M>, PeerError>
    /** For the remote listener: `send` writes an `ask` frame to the desktop's socket. */
    readonly join: (send: (frame: AskFrame) => void) => Hub
  }
>()("hinacode/Peers") {}

interface Joined {
  readonly send: (frame: AskFrame) => void
  readonly pending: Map<number, (envelope: RpcEnvelope<unknown>) => void>
}

const failure = (tag: string, message: string): RpcEnvelope<never> => ({ error: { tag, message } })

const make = Effect.gen(function* () {
  const environments = yield* Environments
  const hubs: Array<Joined> = []
  let nextId = 1

  const throughHub = (hub: Joined, method: AskableMethod, payload: unknown) =>
    Effect.callback<RpcEnvelope<unknown>>((resume) => {
      const id = nextId++
      hub.pending.set(id, (envelope) => resume(Effect.succeed(envelope)))
      hub.send({ type: "ask", id, method, ...(payload !== undefined && { payload }) })
      return Effect.sync(() => hub.pending.delete(id))
    }).pipe(
      Effect.timeoutOrElse({
        duration: ASK_TIMEOUT,
        orElse: () => Effect.succeed(failure("Timeout", "The desktop did not answer in time.")),
      }),
    )

  const throughClouds = (method: AskableMethod, payload: unknown): Effect.Effect<RpcEnvelope<unknown>> =>
    Effect.flatMap(environments.list.pipe(Effect.orElseSucceed(() => ({ clouds: [] }))), ({ clouds }) =>
      clouds.length === 0
        ? Effect.succeed(failure("NoPeers", "This machine is not connected to any other HinaCode machine."))
        : throughPairedClouds(method, payload),
    )

  const throughPairedClouds = (method: AskableMethod, payload: unknown): Effect.Effect<RpcEnvelope<unknown>> => {
    const where = routes[method]
    if (where.to === "all") return Effect.map(environments.gather({ method, payload }), (result) => ({ result }))
    const id = where.to === "owner" ? (payload as Record<string, unknown>)[where.key] : undefined
    const owner = where.to === "owner" && typeof id === "string" ? environments.owner(where.entity, id) : undefined
    return owner === undefined
      ? Effect.succeed(failure("NotFoundError", `No other machine holds ${String(id)}.`))
      : environments.forward(owner, { method, payload })
  }

  const ask = <M extends AskableMethod>(method: M, payload: RpcRequest<M>) =>
    Effect.suspend(() => {
      const hub = hubs.at(-1)
      return hub === undefined ? throughClouds(method, payload) : throughHub(hub, method, payload)
    }).pipe(
      Effect.flatMap((envelope) =>
        "error" in envelope
          ? Effect.fail<PeerError>({ message: envelope.error.message })
          : (
              Schema.decodeUnknownEffect(RpcMethods[method].response)(envelope.result) as Effect.Effect<
                RpcResponse<M>,
                Schema.SchemaError
              >
            ).pipe(
              Effect.mapError((error): PeerError => ({ message: `Unexpected answer to ${method}: ${error.message}` })),
            ),
      ),
    )

  const join = (send: (frame: AskFrame) => void): Hub => {
    const joined: Joined = { send, pending: new Map() }
    hubs.push(joined)
    return {
      answer: (id, envelope) => {
        joined.pending.get(id)?.(envelope)
        joined.pending.delete(id)
      },
      leave: () => {
        hubs.splice(hubs.indexOf(joined), 1)
        for (const settle of joined.pending.values()) settle(failure("HubGone", "The desktop disconnected."))
        joined.pending.clear()
      },
    }
  }

  return Peers.of({ ask, join })
})

export const layer = Layer.effect(Peers, make)
