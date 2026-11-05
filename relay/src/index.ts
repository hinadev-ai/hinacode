import { makeApp } from "./app"
import { accountProfile, verifySession } from "./clerk"

export default makeApp({
  verifySession,
  accountProfile,
  cloudflare: (input, init) => fetch(input, init),
  now: () => Date.now(),
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
})
