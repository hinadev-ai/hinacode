import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import type { RemotePairing } from "../shared/domain.ts"
import { readPairingText, serveOutput } from "./daemon.ts"
import * as Db from "./db/client.ts"
import { layer as RemoteAccessLayer, RemoteAccess } from "./remote/access.ts"
import { applyServeConfig } from "./serve.ts"
import { layer as SecretsLayer, noKeyring, Secrets } from "./services/Secrets.ts"
import { layer as SettingsLayer, type Settings } from "./services/Settings.ts"

const cloud = (userData: string) =>
  ManagedRuntime.make(
    RemoteAccessLayer.pipe(
      Layer.provideMerge(Layer.mergeAll(SettingsLayer(userData), SecretsLayer)),
      Layer.provideMerge(Db.layer(join(userData, "hinacode.sqlite"))),
      Layer.provide(Layer.mergeAll(NodeServices.layer, noKeyring)),
    ),
  )

const inCloud = async <A, E>(userData: string, effect: Effect.Effect<A, E, RemoteAccess | Secrets | Settings>) => {
  const runtime = cloud(userData)
  try {
    return await runtime.runPromise(effect)
  } finally {
    await runtime.dispose()
  }
}

const hasToken = Secrets.use((secrets) => secrets.has("remote.token"))

describe("readPairingText", () => {
  it("waits for the daemon's token instead of minting one", async () => {
    const userData = mkdtempSync(join(tmpdir(), "kk-daemon-pairing-"))
    await inCloud(userData, applyServeConfig({ rotateToken: false }))

    expect(await readPairingText(userData)).toBeUndefined()
    expect(await inCloud(userData, hasToken)).toBe(false)

    const { token } = await inCloud(
      userData,
      RemoteAccess.use((remote) => remote.pairing),
    )
    const text = await readPairingText(userData)
    expect(text).toContain(token)
    expect(
      await inCloud(
        userData,
        Secrets.use((secrets) => secrets.get("remote.token")),
      ),
    ).toMatchObject({
      value: token,
    })
  })
})

describe("serveOutput", () => {
  const pairing: RemotePairing = { hosts: ["127.0.0.1"], port: 49152, token: "the-cloud-token", relay: null }

  it("keeps the token out of output that is not a terminal, such as a service log", async () => {
    const text = await serveOutput("/data", pairing, false)
    expect(text).not.toContain(pairing.token)
    expect(text).toContain("hinacode pair")
  })

  it("prints the pairing block to a terminal", async () => {
    expect(await serveOutput("/data", pairing, true)).toContain(pairing.token)
  })
})
