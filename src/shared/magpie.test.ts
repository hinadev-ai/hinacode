import { describe, expect, test } from "vitest"
import { gatewayModelOf, magpieModelId, magpieSourceOf } from "./magpie.ts"

describe("magpie model ids", () => {
  test("round trip a gateway model through the HinaCode id", () => {
    expect(magpieModelId("group/daily")).toBe("magpie/group/daily")
    expect(gatewayModelOf(magpieModelId("opencode-go/kimi-k3"))).toBe("opencode-go/kimi-k3")
  })

  test("read the source from the first segment of the gateway model", () => {
    expect(magpieSourceOf("magpie/group/daily")).toBe("group")
    expect(magpieSourceOf("magpie/openrouter/x")).toBe("openrouter")
  })

  test("treat a native model id as not magpie", () => {
    expect(gatewayModelOf("claude-opus-5-5")).toBeNull()
    expect(magpieSourceOf("claude-opus-5-5")).toBeNull()
  })
})
