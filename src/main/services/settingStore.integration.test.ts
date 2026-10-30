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

  it.effect("starts from defaults when a hand edit broke the file, and refuses to overwrite it", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        const path = join(dir, "settings.json")
        writeFileSync(path, "{ archive: ")
        const settings = yield* Settings.Settings
        expect(yield* settings.get).toEqual(defaultSettings)
        expect((yield* Effect.flip(settings.set({ defaultProvider: "codex" }))).message).toContain(path)
        expect(readFileSync(path, "utf8")).toBe("{ archive: ")
      }),
    ),
  )

  it.effect("keeps the rest of the settings when one value has the wrong type", () =>
    withDataDir((dir) =>
      Effect.gen(function* () {
        writeFileSync(
          join(dir, "settings.json"),
          JSON.stringify({ defaultProvider: 42, textGenerationModel: "claude-opus-5-5" }),
        )
        writeFileSync(join(dir, "client-settings.json"), JSON.stringify({ locale: "ja" }))
        writeFileSync(join(dir, "keybindings.json"), "{ oops")
        expect(yield* Settings.Settings.use((settings) => settings.get)).toEqual({
          ...defaultSettings,
          textGenerationModel: "claude-opus-5-5",
        })
        expect(yield* ClientSettings.ClientSettings.use((client) => client.get)).toEqual({
          ...defaultClientSettings,
          locale: "ja",
        })
      }),
    ),
  )

  it.effect("defaults the VM provider to boat on a fresh install", () =>
    withDataDir(() =>
      Effect.gen(function* () {
        expect((yield* Settings.Settings.use((settings) => settings.get)).experimental.tinyVmProvider).toBe("boat")
      }),
    ),
  )

  it.effect("defaults the VM provider to boat when experimental was never stored", () =>
    withDataDir((dir) => {
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ textGenerationModel: "claude-opus-5-5" }))
      return Effect.gen(function* () {
        expect((yield* Settings.Settings.use((settings) => settings.get)).experimental.tinyVmProvider).toBe("boat")
      })
    }),
  )

  it.effect("keeps a pre-boat install on sbx and stamps the choice into the file", () =>
    withDataDir((dir) => {
      const path = join(dir, "settings.json")
      writeFileSync(path, JSON.stringify({ experimental: { tinyVm: true, tinyVmTemplate: "mine" } }))
      return Effect.gen(function* () {
        const { experimental } = yield* Settings.Settings.use((settings) => settings.get)
        expect(experimental.tinyVmProvider).toBe("sbx")
        expect(experimental.tinyVmTemplate).toBe("mine")
        expect(readJson(path)).toEqual({
          experimental: { tinyVm: true, tinyVmTemplate: "mine", tinyVmProvider: "sbx" },
        })
      })
    }),
  )

  it.effect("leaves a stored VM provider choice alone", () =>
    withDataDir((dir) => {
      const path = join(dir, "settings.json")
      writeFileSync(path, JSON.stringify({ experimental: { tinyVmProvider: "boat" } }))
      return Effect.gen(function* () {
        expect((yield* Settings.Settings.use((settings) => settings.get)).experimental.tinyVmProvider).toBe("boat")
        expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ experimental: { tinyVmProvider: "boat" } }))
      })
    }),
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
