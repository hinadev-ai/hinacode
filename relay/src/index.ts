import { makeApp } from "./app"
import { verifySession } from "./clerk"

export default makeApp({
  verifySession,
  cloudflare: (input, init) => fetch(input, init),
  now: () => Date.now(),
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
})
