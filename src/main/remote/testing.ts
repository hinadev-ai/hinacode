import { createServer } from "node:net"

export const unusedLoopbackPort = async (): Promise<number> => {
  const reservation = createServer()
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = reservation.address()
    if (address === null || typeof address === "string") throw new Error("No TCP address for the reserved port")
    return address.port
  } finally {
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error === undefined ? resolve() : reject(error))),
    )
  }
}
