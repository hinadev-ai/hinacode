import { Context, Layer } from "effect"
import { ClientSettings as ClientSettingsSchema, defaultClientSettings } from "../../shared/domain.ts"
import { makeSettingStore, type SettingStore } from "./settingStore.ts"

/** Settings of this desktop, answered locally whichever environment is active. */
export class ClientSettings extends Context.Service<ClientSettings, SettingStore<ClientSettingsSchema>>()(
  "kkcode/ClientSettings",
) {}

export const layer = Layer.effect(
  ClientSettings,
  makeSettingStore(ClientSettingsSchema, defaultClientSettings, "clientSettings"),
)
