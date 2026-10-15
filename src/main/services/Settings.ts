import { Context, Layer } from "effect"
import { defaultSettings, Settings as SettingsSchema } from "../../shared/domain.ts"
import { makeSettingStore, type SettingStore } from "./settingStore.ts"

/** Settings of the environment agents run in. A cloud reads only these. */
export class Settings extends Context.Service<Settings, SettingStore<SettingsSchema>>()("kkcode/Settings") {}

export const layer = Layer.effect(Settings, makeSettingStore(SettingsSchema, defaultSettings, "settings"))
