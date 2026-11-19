import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Context, Effect, Layer, Predicate } from "effect"
import { defaultSettings, Settings as SettingsSchema, vmProviderBeforeTheChoice } from "../../shared/domain.ts"
import { makeSettingStore, type SettingStore } from "./settingStore.ts"

export class Settings extends Context.Service<Settings, SettingStore<SettingsSchema>>()("hinacode/Settings") {}

const valuesBeforeTheirDefault = [
  { group: "experimental", key: "tinyVmProvider", value: vmProviderBeforeTheChoice },
  { group: "archive", key: "archiveAfterSettledDays", value: null },
] as const

const stampLegacyValues = (path: string) => {
  try {
    if (!existsSync(path)) return
    const stored: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!Predicate.isObject(stored)) return
    const missing = valuesBeforeTheirDefault.filter(({ group, key }) => {
      const saved = stored[group]
      return Predicate.isObject(saved) && saved[key] === undefined
    })
    if (missing.length === 0) return
    const next: Record<PropertyKey, unknown> = { ...stored }
    for (const { group, key, value } of missing) next[group] = { ...(next[group] as object), [key]: value }
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`)
    renameSync(temp, path)
  } catch {
    return
  }
}

export const defaultsFor = (env: Readonly<Record<string, string | undefined>>): SettingsSchema =>
  env["BOAT_ID"]
    ? { ...defaultSettings, experimental: { ...defaultSettings.experimental, tinyVm: true, tinyVmProvider: "boat" } }
    : defaultSettings

export const layer = (dataDir: string, defaults: SettingsSchema = defaultSettings) =>
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      const path = join(dataDir, "settings.json")
      yield* Effect.sync(() => stampLegacyValues(path))
      return yield* makeSettingStore(SettingsSchema, defaults, { path })
    }),
  )
