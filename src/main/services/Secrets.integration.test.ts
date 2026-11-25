import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import * as Db from "../db/client.ts"
import * as SecretsModule from "./Secrets.ts"
import { type SafeStorage, Secrets, safeStorageKeyring } from "./Secrets.ts"

const KEYRING_KEY = "v11"
const HARDCODED_KEY = "v10"

const secretsService = Effect.gen(function* () {
  return yield* Secrets
})

const fakeSafeStorage = (linuxBackend: string): SafeStorage => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => linuxBackend,
  encryptString: (value) => Buffer.from(`${linuxBackend === "basic_text" ? HARDCODED_KEY : KEYRING_KEY}${value}`),
  decryptString: (sealed) => {
    const text = sealed.toString()
    const key = text.slice(0, 3)
    if (key === HARDCODED_KEY || (key === KEYRING_KEY && linuxBackend !== "basic_text")) return text.slice(3)
    throw new Error("not sealed by this key")
  },
})

const secretsOver = (keyring: Layer.Layer<SecretsModule.Keyring>) =>
  SecretsModule.layer.pipe(Layer.provideMerge(keyring), Layer.provide(NodeServices.layer))

const storedRow = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ readonly value: string }>`SELECT value FROM setting WHERE key = ${`secret.${name}`}`
    return JSON.parse(row!.value) as { readonly encrypted: boolean; readonly value: string }
  })

const insertRow = (name: string, stored: { readonly encrypted: boolean; readonly value: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`INSERT INTO setting (key, value) VALUES (${`secret.${name}`}, ${JSON.stringify(stored)})`
  })

describe("Secrets", () => {
  it.effect("reads a secret sealed under another key as unset, and saves it again", () =>
    Effect.gen(function* () {
      yield* insertRow("remote.token", { encrypted: true, value: Buffer.from("other key").toString("base64") })
      const secrets = yield* Effect.provide(secretsService, secretsOver(SecretsModule.noKeyring))

      expect(yield* secrets.get("remote.token")).toStrictEqual(Option.none())
      yield* secrets.set("remote.token", "fresh")
      expect(yield* secrets.get("remote.token")).toStrictEqual(Option.some("fresh"))
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

  it.effect("treats Linux basic_text as no keyring and stores plaintext", () =>
    Effect.gen(function* () {
      const secrets = yield* Effect.provide(
        secretsService,
        secretsOver(safeStorageKeyring(fakeSafeStorage("basic_text"), "linux")),
      )
      yield* secrets.set("linear.apiKey", "lin_123")

      expect(secrets.backend).toBe("none")
      expect(yield* storedRow("linear.apiKey")).toStrictEqual({ encrypted: false, value: "lin_123" })
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

  it.effect("names the real Linux backend and seals with it", () =>
    Effect.gen(function* () {
      const secrets = yield* Effect.provide(
        secretsService,
        secretsOver(safeStorageKeyring(fakeSafeStorage("gnome_libsecret"), "linux")),
      )
      yield* secrets.set("linear.apiKey", "lin_123")

      expect(secrets.backend).toBe("libsecret")
      expect((yield* storedRow("linear.apiKey")).encrypted).toBe(true)
      expect(yield* secrets.get("linear.apiKey")).toStrictEqual(Option.some("lin_123"))
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

  it.effect("seals plaintext rows at startup once a real keyring is there", () =>
    Effect.gen(function* () {
      yield* insertRow("linear.apiKey", { encrypted: false, value: "lin_123" })
      const secrets = yield* Effect.provide(
        secretsService,
        secretsOver(safeStorageKeyring(fakeSafeStorage("kwallet6"), "linux")),
      )

      const stored = yield* storedRow("linear.apiKey")
      expect(stored.encrypted).toBe(true)
      expect(stored.value).not.toContain("lin_123")
      expect(yield* secrets.get("linear.apiKey")).toStrictEqual(Option.some("lin_123"))
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

  it.effect("stores basic_text rows as plaintext, so a later keyring seals them", () =>
    Effect.gen(function* () {
      const legacy = Buffer.from(`${HARDCODED_KEY}lin_123`).toString("base64")
      yield* insertRow("linear.apiKey", { encrypted: true, value: legacy })
      yield* Effect.provide(secretsService, secretsOver(safeStorageKeyring(fakeSafeStorage("basic_text"), "linux")))

      expect(yield* storedRow("linear.apiKey")).toStrictEqual({ encrypted: false, value: "lin_123" })
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

  it.effect("leaves no copy of a resealed plaintext secret in the database files", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hinacode-reseal-")), "hinacode.sqlite")
    const fileBytes = () =>
      [path, `${path}-wal`]
        .filter(existsSync)
        .map((file) => readFileSync(file).toString("latin1"))
        .join("")
    return Effect.gen(function* () {
      yield* insertRow("linear.apiKey", { encrypted: false, value: "lin_plaintext_marker" })
      expect(fileBytes()).toContain("lin_plaintext_marker")
      yield* Effect.provide(secretsService, secretsOver(safeStorageKeyring(fakeSafeStorage("kwallet6"), "linux")))

      expect(fileBytes()).not.toContain("lin_plaintext_marker")
    }).pipe(Effect.provide(Db.layer(path)))
  })

  it.effect("seals basic_text rows again once a real keyring is there", () =>
    Effect.gen(function* () {
      yield* insertRow("linear.apiKey", {
        encrypted: true,
        value: Buffer.from(`${HARDCODED_KEY}lin_123`).toString("base64"),
      })
      const secrets = yield* Effect.provide(
        secretsService,
        secretsOver(safeStorageKeyring(fakeSafeStorage("gnome_libsecret"), "linux")),
      )

      const stored = yield* storedRow("linear.apiKey")
      expect(Buffer.from(stored.value, "base64").toString()).toBe(`${KEYRING_KEY}lin_123`)
      expect(yield* secrets.get("linear.apiKey")).toStrictEqual(Option.some("lin_123"))
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )

  it.effect("lists and clears only the names under a prefix", () =>
    Effect.gen(function* () {
      const secrets = yield* Effect.provide(secretsService, secretsOver(SecretsModule.noKeyring))
      yield* secrets.set("thread.a.STRIPE_KEY", "1")
      yield* secrets.set("thread.a.GH_TOKEN", "2")
      yield* secrets.set("thread.ab.OTHER", "3")

      expect([...(yield* secrets.namesUnder("thread.a."))].sort()).toStrictEqual(["GH_TOKEN", "STRIPE_KEY"])
      yield* secrets.clearUnder("thread.a.")
      expect(yield* secrets.namesUnder("thread.a.")).toStrictEqual([])
      expect(yield* secrets.get("thread.ab.OTHER")).toStrictEqual(Option.some("3"))
    }).pipe(Effect.provide(Db.layer(":memory:"))),
  )
})
