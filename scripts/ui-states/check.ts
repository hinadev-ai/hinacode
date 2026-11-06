import { Schema } from "effect"
import { PushEvent, type RpcMethod, RpcMethods } from "../../src/shared/contract.ts"
import { defaultSettings, Settings } from "../../src/shared/domain.ts"
import { baseOverrides, cloudBaseOverrides, type Overrides, type Reply, scenarios } from "./scenarios.ts"

const failures: Array<string> = []

const repliesOf = (override: NonNullable<Overrides[RpcMethod]>): ReadonlyArray<[string, Reply<RpcMethod>]> =>
  typeof override === "object" && "by" in override
    ? Object.entries(override.replies).map(([key, reply]) => [`${override.by}=${key}`, reply])
    : [["", override as Reply<RpcMethod>]]

const checkOverrides = (where: string, overrides: Overrides | undefined) => {
  for (const [method, override] of Object.entries(overrides ?? {}) as Array<[RpcMethod, Overrides[RpcMethod]]>) {
    if (!(method in RpcMethods)) {
      failures.push(`${where}: unknown method ${method}`)
      continue
    }
    for (const [key, reply] of repliesOf(override!)) {
      if (reply === "pending" || "error" in reply) continue
      try {
        Schema.decodeUnknownSync(RpcMethods[method].response)(reply.result)
      } catch (cause) {
        failures.push(`${where} ${method}${key && ` (${key})`}: ${String(cause)}`)
      }
    }
  }
}

checkOverrides("base", baseOverrides)
checkOverrides("base clouds", cloudBaseOverrides)

const names = new Set<string>()
for (const scenario of scenarios) {
  if (names.has(scenario.name)) failures.push(`${scenario.name}: duplicate name`)
  names.add(scenario.name)
  if (!/^[a-z]+-[a-z0-9-]+$/.test(scenario.name)) failures.push(`${scenario.name}: name is not <surface>-<state>`)
  checkOverrides(scenario.name, scenario.overrides)
  checkOverrides(`${scenario.name} clouds`, scenario.cloudOverrides)
  for (const event of scenario.events ?? []) {
    try {
      Schema.decodeUnknownSync(PushEvent)(event)
    } catch (cause) {
      failures.push(`${scenario.name} event ${event.type}: ${String(cause)}`)
    }
  }
  if (scenario.experimental) {
    const encoded = Schema.encodeSync(Settings)(defaultSettings)
    try {
      Schema.decodeUnknownSync(Settings)({
        ...encoded,
        experimental: { ...encoded.experimental, ...scenario.experimental },
      })
    } catch (cause) {
      failures.push(`${scenario.name} experimental: ${String(cause)}`)
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n\n"))
  console.error(`\n${failures.length} fixture(s) do not match the rpc contract`)
  process.exit(1)
}
console.log(`${scenarios.length} scenarios match the rpc contract`)
