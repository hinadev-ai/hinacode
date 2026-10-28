import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Redacted } from "effect"
import { readLogin, sbxClient } from "./sbx.ts"
import { startFakeSbx } from "./testing.ts"

const configFile = (contents: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "kk-sbx-login-")), "config.json")
  writeFileSync(path, contents)
  return path
}

describe("readLogin", () => {
  it.effect("SBX_URL and SBX_TOKEN win over the config file", () =>
    Effect.gen(function* () {
      const configPath = configFile(JSON.stringify({ url: "http://file:7070", token: "from-file" }))
      const login = yield* readLogin({ configPath, env: { SBX_URL: "http://env:7070", SBX_TOKEN: "from-env" } })
      expect(login.url).toBe("http://env:7070")
      expect(Redacted.value(login.token)).toBe("from-env")
    }),
  )

  it.effect("reads the file sbx login writes", () =>
    Effect.gen(function* () {
      const configPath = configFile(JSON.stringify({ url: "http://file:7070", token: "from-file" }))
      const login = yield* readLogin({ configPath, env: {} })
      expect(login.url).toBe("http://file:7070")
      expect(Redacted.value(login.token)).toBe("from-file")
    }),
  )

  it.effect("a missing file means sbx is not configured", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(readLogin({ configPath: join(tmpdir(), "no-such-dir", "config.json"), env: {} }))
      expect(error._tag).toBe("SbxNotConfiguredError")
      expect(error.message).toContain("sbx login")
    }),
  )

  it.effect("a malformed file is a clear error that does not echo the token", () =>
    Effect.gen(function* () {
      const configPath = configFile(JSON.stringify({ url: 7070, token: "secret-token" }))
      const error = yield* Effect.flip(readLogin({ configPath, env: {} }))
      expect(error._tag).toBe("SbxError")
      expect(error.message).toContain(configPath)
      expect(error.message).not.toContain("secret-token")
      const notJsonPath = configFile("{")
      const notJson = yield* Effect.flip(readLogin({ configPath: notJsonPath, env: {} }))
      expect(notJson.message).toContain(notJsonPath)
    }),
  )
})

describe("getFiles", () => {
  it.effect("stops reading an archive once it passes the cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* startFakeSbx
        const sbx = sbxClient({ url: fake.url, token: Redacted.make(fake.token) })
        const { id } = yield* sbx.create("default")
        fake.seedFile(id, "big", new Uint8Array(4096))
        expect((yield* sbx.getFiles(id, "big", 4096)).length).toBe(4096)
        const error = yield* Effect.flip(sbx.getFiles(id, "big", 4095))
        expect(error.message).toContain("larger than")
      }),
    ),
  )
})
