import { join } from "node:path"
import { Context, Layer } from "effect"
import { defaultSettings, Settings as SettingsSchema } from "../../shared/domain.ts"
import { makeSettingStore, type SettingStore } from "./settingStore.ts"

/** Settings of the environment agents run in. A cloud reads only these. */
export class Settings extends Context.Service<Settings, SettingStore<SettingsSchema>>()("hinacode/Settings") {}

/** Kept in `<dataDir>/settings.json`. */
export const layer = (dataDir: string) =>
  Layer.effect(Settings, makeSettingStore(SettingsSchema, defaultSettings, { path: join(dataDir, "settings.json") }))
