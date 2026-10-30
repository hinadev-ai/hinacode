import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, Layer, Predicate } from "effect"
import { defaultSettings, Settings as SettingsSchema } from "../../shared/domain.ts"
import { makeSettingStore, type SettingStore } from "./settingStore.ts"

export class Settings extends Context.Service<Settings, SettingStore<SettingsSchema>>()("hinacode/Settings") {}

const stampLegacyVmProvider = (path: string) => {
  try {
    if (!existsSync(path)) return
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!Predicate.isObject(stored) || !Predicate.isObject(stored.experimental)) return
    if (stored.experimental.tinyVmProvider !== undefined) return
    const next = { ...stored, experimental: { ...stored.experimental, tinyVmProvider: "sbx" } }
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, path)
  } catch {
    return
  }
}

export const layer = (dataDir: string) =>
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      const path = join(dataDir, "settings.json")
      yield* Effect.sync(() => stampLegacyVmProvider(path))
      return yield* makeSettingStore(SettingsSchema, defaultSettings, { path })
    }),
  )
