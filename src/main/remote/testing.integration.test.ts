import { createServer } from "node:net"
import { expect, test, vi } from "vitest"
import { unusedLoopbackPort } from "./testing.ts"

test("allocates a bindable loopback port when the random candidate is occupied", async () => {
  const occupied = createServer()
  await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
  const address = occupied.address()
  if (address === null || typeof address === "string") throw new Error("No TCP address for the occupied port")
  try {
    const random = vi.spyOn(Math, "random").mockReturnValue((address.port - 40000 + 0.5) / 20000)
    let port: number
    try {
      port = await unusedLoopbackPort()
    } finally {
      random.mockRestore()
    }
    const probe = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        probe.once("error", reject)
        probe.listen(port, "127.0.0.1", resolve)
      })
      expect(probe.listening).toBe(true)
    } finally {
      await new Promise<void>((resolve) => probe.close(() => resolve()))
    }
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
  }
})
