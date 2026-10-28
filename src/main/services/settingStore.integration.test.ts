import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { defaultClientSettings, defaultSettings } from "../../shared/domain.ts"
import * as ClientSettings from "./ClientSettings.ts"
import * as Settings from "./Settings.ts"

const withDataDir = <A, E>(
  run: (dir: string) => Effect.Effect<A, E, Settings.Settings | ClientSettings.ClientSettings>,
) => {
  const dir = mkdtempSync(join(tmpdir(), "kk-settings-"))
  return run(dir).pipe(Effect.provide(Layer.mergeAll(Settings.layer(dir), ClientSettings.layer(dir))))
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as unknown

describe("setting files", () => {
  it.effect("writes only the keys that were set, and reads them back", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        const settings = yield* Settings.Settings
        yield* settings.set({ textGenerationModel: "claude-opus-5-5" })
        expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(
          `{\n  "textGenerationModel": "claude-opus-5-5"\n}\n`,
        )
        expect(yield* settings.get).toEqual({ ...defaultSettings, textGenerationModel: "claude-opus-5-5" })
      }),
    ),
  )

  it.effect("reads a file edited by hand on the next get", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        const client = yield* ClientSettings.ClientSettings
        expect((yield* client.get).appearance.theme).toBe("system")
        writeFileSync(join(dir, "client-settings.json"), JSON.stringify({ appearance: { theme: "dracula" } }))
        expect((yield* client.get).appearance).toEqual({ ...defaultClientSettings.appearance, theme: "dracula" })
      }),
    ),
  )

  it.effect("fills the keys a stored object is missing from its defaults", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ archive: { whenMerged: true } }))
        expect((yield* Settings.Settings.use((settings) => settings.get)).archive).toEqual({
          ...defaultSettings.archive,
          whenMerged: true,
        })
      }),
    ),
  )

  it.effect("fails with the file's path when it is not valid JSON, and leaves it alone", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "settings.json")
        writeFileSync(path, "{ archive: ")
        const settings = yield* Settings.Settings
        expect((yield* Effect.flip(settings.get)).message).toContain(path)
        expect((yield* Effect.flip(settings.set({ defaultProvider: "codex" }))).message).toContain(path)
        expect(readFileSync(path, "utf8")).toBe("{ archive: ")
      }),
    ),
  )

  it.effect("keeps keybindings in keybindings.json as a bare record", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        const client = yield* ClientSettings.ClientSettings
        yield* client.set({ locale: "ja", keybindings: { "thread.new": "mod+shift+n" } })
        expect(readJson(join(dir, "keybindings.json"))).toEqual({ "thread.new": "mod+shift+n" })
        expect(readJson(join(dir, "client-settings.json"))).toEqual({ locale: "ja" })
        writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "palette.open": "mod+p" }))
        expect(yield* client.get).toEqual({
          ...defaultClientSettings,
          locale: "ja",
          keybindings: { "palette.open": "mod+p" },
        })
      }),
    ),
  )
})
