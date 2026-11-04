import { verifyToken } from "@clerk/backend"
import { TokenVerificationError, TokenVerificationErrorReason } from "@clerk/backend/errors"
import { bearer } from "./app"

const CLERK_UNAVAILABLE: readonly string[] = [
  TokenVerificationErrorReason.RemoteJWKFailedToLoad,
  TokenVerificationErrorReason.RemoteJWKInvalid,
  TokenVerificationErrorReason.InvalidSecretKey,
]

type VerifyToken = (
  token: string,
  options: { secretKey: string; authorizedParties: string[] },
) => Promise<{ sub: string; sts?: string }>

export const makeVerifySession =
  (verify: VerifyToken) =>
  async (request: Request, env: Env): Promise<string | null> => {
    const token = bearer(request)
    if (!token) return null
    try {
      const session = await verify(token, {
        secretKey: env.CLERK_SECRET_KEY,
        authorizedParties: [new URL(request.url).origin],
      })
      return session.sts === "pending" ? null : session.sub
    } catch (error) {
      if (error instanceof TokenVerificationError && !CLERK_UNAVAILABLE.includes(error.reason)) return null
      throw error
    }
  }

export const verifySession = makeVerifySession(verifyToken)
