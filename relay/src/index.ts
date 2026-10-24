import { makeApp } from "./app"
import { verifyOwner } from "./owner"

export default makeApp({
  verifyUser: verifyOwner,
  cloudflare: (input, init) => fetch(input, init),
  now: () => Date.now(),
  random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
})
