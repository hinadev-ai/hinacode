import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { vi } from "vitest"
import * as Db from "../db/client.ts"
import { Linear, LINEAR_API_KEY_SECRET } from "./Linear.ts"
import * as LinearModule from "./Linear.ts"
import { Secrets } from "./Secrets.ts"
import * as SecretsModule from "./Secrets.ts"

const linear = vi.hoisted(() => ({
  apiKeys: [] as Array<string>,
  data: undefined as unknown,
}))

vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    readonly client = { rawRequest: async () => ({ data: linear.data }) }
    constructor({ apiKey }: { readonly apiKey: string }) {
      linear.apiKeys.push(apiKey)
    }
  },
}))

const testLayer = LinearModule.layer.pipe(
  Layer.provideMerge(SecretsModule.layer),
  Layer.provideMerge(Db.layer(":memory:")),
  Layer.provide(Layer.mergeAll(NodeServices.layer, SecretsModule.noKeyring)),
)

const issue = {
  id: "issue-1",
  identifier: "ENG-123",
  title: "Retry webhook deliveries",
  url: "https://linear.app/acme/issue/ENG-123",
  priority: 2,
  updatedAt: "2026-10-24T03:00:00.000Z",
  state: { name: "In Progress", type: "started" },
}

describe("Linear", () => {
  it.effect("lists nothing and never builds a client on a machine without a key", () =>
    Effect.gen(function* () {
      linear.apiKeys.length = 0
      expect(yield* Linear.use((service) => service.assignedIssues)).toStrictEqual([])
      expect(linear.apiKeys).toStrictEqual([])
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("decodes the assigned issues with the machine's key", () =>
    Effect.gen(function* () {
      yield* Secrets.use((secrets) => secrets.set(LINEAR_API_KEY_SECRET, "lin_api_test"))
      linear.data = { issues: { nodes: [{ ...issue, description: "not part of the contract" }] } }
      expect(yield* Linear.use((service) => service.assignedIssues)).toStrictEqual([issue])
      expect(linear.apiKeys.at(-1)).toBe("lin_api_test")
    }).pipe(Effect.provide(testLayer)),
  )

  it.effect("fails with a Linear error when the answer has the wrong shape", () =>
    Effect.gen(function* () {
      yield* Secrets.use((secrets) => secrets.set(LINEAR_API_KEY_SECRET, "lin_api_test"))
      linear.data = { issues: { nodes: [{ ...issue, title: null }] } }
      const error = yield* Effect.flip(Linear.use((service) => service.assignedIssues))
      expect(error._tag).toBe("LinearRequestError")
    }).pipe(Effect.provide(testLayer)),
  )
})
