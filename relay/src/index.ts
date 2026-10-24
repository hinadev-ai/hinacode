import { verifyToken } from "@clerk/backend"
import { env } from "cloudflare:workers"
import { bearer, makeApp } from "./app"

export default makeApp({
  async verifyUser(request) {
    const token = bearer(request)
    if (!token) return null
    try {
      const payload = await verifyToken(token, {
        secretKey: env.CLERK_SECRET_KEY,
        authorizedParties: [new URL(request.url).origin],
      })
      return payload.sub
    } catch {
      return null
    }
  },
  cloudflare: (input, init) => fetch(input, init),
  now: () => Date.now(),
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
})
