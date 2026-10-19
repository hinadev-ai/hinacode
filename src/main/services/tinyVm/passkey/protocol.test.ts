import { describe, expect, it } from "vitest"
import { validateRequest, type GuestRequest } from "./protocol.ts"

const request = (overrides: Partial<GuestRequest>): GuestRequest => ({
  kind: "get",
  requestId: 1,
  origin: "https://github.com",
  requestDetailsJson: JSON.stringify({ rpId: "github.com", challenge: "Y2hhbGxlbmdl" }),
  ...overrides,
})

describe("validateRequest", () => {
  it("accepts a request whose rpId is the origin host", () => {
    expect(validateRequest(request({}))).toStrictEqual({
      kind: "get",
      origin: "https://github.com",
      rpId: "github.com",
      requestDetailsJson: JSON.stringify({ rpId: "github.com", challenge: "Y2hhbGxlbmdl" }),
    })
  })

  it("accepts a subdomain origin claiming its parent rpId", () => {
    const result = validateRequest(
      request({
        origin: "https://login.example.com",
        requestDetailsJson: JSON.stringify({ rpId: "example.com", challenge: "YQ" }),
      }),
    )
    expect(result).toMatchObject({ origin: "https://login.example.com", rpId: "example.com" })
  })

  it("defaults the rpId to the origin host when the site omits it", () => {
    const result = validateRequest(request({ requestDetailsJson: JSON.stringify({ challenge: "YQ" }) }))
    expect(result).toMatchObject({ rpId: "github.com" })
  })

  it("reads the rpId from rp.id for create requests", () => {
    const result = validateRequest(
      request({ kind: "create", requestDetailsJson: JSON.stringify({ rp: { id: "github.com" }, challenge: "YQ" }) }),
    )
    expect(result).toMatchObject({ kind: "create", rpId: "github.com" })
  })

  it("rejects an rpId the origin may not claim", () => {
    const result = validateRequest(
      request({
        origin: "https://evil.example",
        requestDetailsJson: JSON.stringify({ rpId: "github.com", challenge: "YQ" }),
      }),
    )
    expect(result).toMatchObject({ error: expect.stringContaining("may not claim") })
  })

  it("rejects plain http away from localhost", () => {
    const result = validateRequest(request({ origin: "http://github.com" }))
    expect(result).toMatchObject({ error: expect.stringContaining("secure origins") })
  })

  it("allows http on localhost for site development", () => {
    const result = validateRequest(
      request({
        origin: "http://localhost:5173",
        requestDetailsJson: JSON.stringify({ rpId: "localhost", challenge: "YQ" }),
      }),
    )
    expect(result).toMatchObject({ origin: "http://localhost:5173", rpId: "localhost" })
  })

  it("rejects request details it cannot read", () => {
    expect(validateRequest(request({ requestDetailsJson: "not json" }))).toMatchObject({
      error: expect.stringContaining("does not understand"),
    })
  })
})
