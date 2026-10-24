import { bearer, sha256 } from "./app"

/** The user id of the relay's one account until it has real sign-in. */
export const OWNER = "owner"

const encoder = new TextEncoder()

const equal = (a: string, b: string) => {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right)
}

/**
 * `OWNER` when the request carries the current owner token: the last one `POST /v1/owner/token` issued, or the
 * `OWNER_TOKEN` secret until the first rotation.
 */
export const verifyOwner = async (request: Request, env: Env): Promise<string | null> => {
  const token = bearer(request)
  if (!token) return null
  const rotated = await env.DB.prepare("SELECT token_hash FROM owner WHERE id = 1").first<string>("token_hash")
  const valid = rotated === null ? equal(token, env.OWNER_TOKEN) : equal(await sha256(token), rotated)
  return valid ? OWNER : null
}
