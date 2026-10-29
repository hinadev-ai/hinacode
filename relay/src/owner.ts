import { Option } from "effect"
import { bearer, sha256 } from "./app"
import { runStore } from "./store"

export const OWNER = "owner"

const encoder = new TextEncoder()

const equal = (a: string, b: string) => {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right)
}

export const verifyOwner = async (request: Request, env: Env): Promise<string | null> => {
  const token = bearer(request)
  if (!token) return null
  const rotated = await runStore(env.DB, (store) => store.ownerTokenHash(undefined))
  const valid = Option.isNone(rotated)
    ? equal(token, env.OWNER_TOKEN)
    : equal(await sha256(token), rotated.value.tokenHash)
  return valid ? OWNER : null
}
