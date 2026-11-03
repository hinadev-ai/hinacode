import type { PushEvent, RpcEnvelope, RpcMethod } from "../../../src/shared/contract.ts"
import type { EnvironmentStatus } from "../../../src/shared/domain.ts"
import {
  learnFromAnswer,
  learnFromPush,
  makeOwners,
  nameMachines,
  stampEnvironment,
  stampPush,
} from "../../../src/shared/owners.ts"
import { routes } from "../../../src/shared/routes.ts"

export interface MachineLink {
  readonly id: string
  readonly name: string
  readonly status: () => EnvironmentStatus
  readonly call: (method: RpcMethod, payload: unknown) => Promise<RpcEnvelope<unknown>>
}

export type BrowserAnswer = (method: RpcMethod, payload: unknown) => Promise<RpcEnvelope<unknown>> | undefined

export const GATHER_TIMEOUT_MS = 3_000

const payloadId = (payload: unknown, key: string) => {
  const id = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)[key] : undefined
  return typeof id === "string" ? id : undefined
}

const notFound = (id: string): RpcEnvelope<never> => ({
  error: { tag: "NotFoundError", message: `No environment with id ${id}` },
})

const within = <A>(ms: number, promise: Promise<A>) =>
  Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))])

export const makeRoute = ({
  home,
  others,
  browser,
}: {
  readonly home: MachineLink
  readonly others: ReadonlyMap<string, MachineLink>
  readonly browser: BrowserAnswer
}) => {
  const owners = makeOwners()
  const remembered = new Map<string, { readonly payload: string; readonly result: unknown }>()

  const forward = async (id: string, method: RpcMethod, payload: unknown): Promise<RpcEnvelope<unknown>> => {
    const machine = others.get(id)
    if (machine === undefined) return notFound(id)
    const envelope = await machine.call(method, payload)
    if ("error" in envelope) return envelope
    learnFromAnswer(owners, id, method, payload, envelope.result)
    const result = nameMachines(method, stampEnvironment(method, envelope.result, id), machine.name)
    remembered.set(`${id} ${method}`, { payload: JSON.stringify(payload ?? null), result })
    return { result }
  }

  const gatherFrom = async (machine: MachineLink, method: RpcMethod, payload: unknown) => {
    const answer =
      machine.status() === "connected"
        ? await within(GATHER_TIMEOUT_MS, forward(machine.id, method, payload))
        : undefined
    if (answer !== undefined && "result" in answer && Array.isArray(answer.result)) return answer.result
    const last = remembered.get(`${machine.id} ${method}`)
    return last?.payload === JSON.stringify(payload ?? null) && Array.isArray(last.result) ? last.result : []
  }

  const call = async (method: RpcMethod, payload: unknown, environment?: string): Promise<RpcEnvelope<unknown>> => {
    const answered = browser(method, payload)
    if (answered !== undefined) return answered
    const where = routes[method]
    const owned = where.to === "owner" ? payloadId(payload, where.key) : undefined
    const target =
      where.to === "named"
        ? environment
        : where.to === "owner" && owned !== undefined
          ? owners.owner(where.entity, owned)
          : undefined
    if (target !== undefined && target !== home.id) return forward(target, method, payload)
    if (where.to !== "all") return home.call(method, payload)
    const [local, ...rest] = await Promise.all([
      home.call(method, payload),
      ...[...others.values()].map((machine) => gatherFrom(machine, method, payload)),
    ])
    if ("error" in local || !Array.isArray(local.result)) return local
    return { result: [...local.result, ...rest.flat()] }
  }

  const push = (machineId: string, event: PushEvent): PushEvent => {
    if (machineId === home.id) return event
    learnFromPush(owners, machineId, event)
    return stampPush(event, machineId)
  }

  return { call, push, forget: owners.forget }
}
