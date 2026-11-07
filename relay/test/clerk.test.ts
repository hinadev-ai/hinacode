import { TokenVerificationError, TokenVerificationErrorReason } from "@clerk/backend/errors"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeVerifySession } from "../src/clerk"

const verifyToken = vi.fn()
const verifySession = makeVerifySession(verifyToken)

const fakeEnv = { CLERK_SECRET_KEY: "sk_test_fake", WEB_ORIGINS: "https://code.test,http://localhost:4420" } as Env
const request = new Request("https://relay.test/v1/hosts", { headers: { Authorization: "Bearer session" } })
const rejectedFor = (reason: string) => new TokenVerificationError({ message: reason, reason })

describe("verifySession", () => {
  beforeEach(() => {
    verifyToken.mockReset()
  })

  it("returns the user of an active session, minted on the relay or on a web origin", async () => {
    verifyToken.mockResolvedValue({ sub: "user_alice", sts: "active" })
    expect(await verifySession(request, fakeEnv)).toBe("user_alice")
    expect(verifyToken).toHaveBeenCalledWith("session", {
      secretKey: "sk_test_fake",
      authorizedParties: ["https://relay.test", "https://code.test", "http://localhost:4420"],
    })
  })

  it("accepts a session token without a status claim", async () => {
    verifyToken.mockResolvedValue({ sub: "user_alice" })
    expect(await verifySession(request, fakeEnv)).toBe("user_alice")
  })

  it("refuses a session that still has a required task to finish", async () => {
    verifyToken.mockResolvedValue({ sub: "user_alice", sts: "pending" })
    expect(await verifySession(request, fakeEnv)).toBeNull()
  })

  it("refuses without calling Clerk when there is no bearer", async () => {
    expect(await verifySession(new Request("https://relay.test/v1/hosts"), fakeEnv)).toBeNull()
    expect(verifyToken).not.toHaveBeenCalled()
  })

  it.each([
    TokenVerificationErrorReason.TokenExpired,
    TokenVerificationErrorReason.TokenInvalid,
    TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
    TokenVerificationErrorReason.TokenInvalidSignature,
    TokenVerificationErrorReason.JWKKidMismatch,
  ])("treats %s as signed out", async (reason) => {
    verifyToken.mockRejectedValue(rejectedFor(reason))
    expect(await verifySession(request, fakeEnv)).toBeNull()
  })

  it.each([
    TokenVerificationErrorReason.RemoteJWKFailedToLoad,
    TokenVerificationErrorReason.RemoteJWKInvalid,
    TokenVerificationErrorReason.InvalidSecretKey,
  ])("reports %s as a failure instead of calling a valid session signed out", async (reason) => {
    verifyToken.mockRejectedValue(rejectedFor(reason))
    await expect(verifySession(request, fakeEnv)).rejects.toThrow(reason)
  })
})
