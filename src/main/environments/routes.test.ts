import { describe, expect, test } from "vitest"
import { type RpcMethod, RpcMethods } from "../../shared/contract.ts"
import { routes } from "./routes.ts"

describe("routes", () => {
  test("every owner route reads a field its method's request has", () => {
    const missing = Object.entries(routes).flatMap(([method, route]) => {
      if (route.to !== "owner") return []
      const request = RpcMethods[method as RpcMethod].request
      const fields = "fields" in request ? Object.keys(request.fields) : []
      return fields.includes(route.key) ? [] : [`${method}.${route.key}`]
    })
    expect(missing).toStrictEqual([])
  })
})
