import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { decodeTar } from "../tar.ts"
import { extensionArchive } from "./extension.ts"

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    manifest_version: Schema.Number,
    permissions: Schema.Array(Schema.String),
    background: Schema.Struct({ service_worker: Schema.String }),
  }),
)

describe("extensionArchive", () => {
  it("holds one top level folder with a manifest that asks for the proxy permission", () => {
    const entries = decodeTar(extensionArchive())
    expect(entries.map((entry) => entry.path)).toStrictEqual([
      "passkey-extension",
      "passkey-extension/manifest.json",
      "passkey-extension/background.js",
      "passkey-extension/content.js",
      "passkey-extension/page.js",
    ])
    const manifest = entries.find((entry) => entry.path.endsWith("manifest.json"))
    if (manifest?.type !== "file") throw new Error("manifest missing")
    const decoded = Schema.decodeUnknownSync(Manifest)(Buffer.from(manifest.data).toString())
    expect(decoded.manifest_version).toBe(3)
    expect(decoded.permissions).toContain("webAuthenticationProxy")
    expect(decoded.permissions).toContain("tabs")
    expect(decoded.background.service_worker).toBe("background.js")
  })

  it("ships a worker that arms the proxy and answers both request kinds", () => {
    const entries = decodeTar(extensionArchive())
    const worker = entries.find((entry) => entry.path.endsWith("background.js"))
    if (worker?.type !== "file") throw new Error("background worker missing")
    const source = Buffer.from(worker.data).toString()
    expect(source).toContain("webAuthenticationProxy.attach()")
    expect(source).toContain("completeGetRequest")
    expect(source).toContain("completeCreateRequest")
    expect(source).toContain("completeIsUvpaaRequest")
  })
})
