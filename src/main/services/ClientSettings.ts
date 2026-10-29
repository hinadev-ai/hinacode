import { join } from "node:path"
import { Context, Layer } from "effect"
import { ClientSettings as ClientSettingsSchema, defaultClientSettings } from "../../shared/domain.ts"
import { makeSettingStore, type SettingStore } from "./settingStore.ts"

/** Settings of this desktop, answered locally whichever environment is active. */
export class ClientSettings extends Context.Service<ClientSettings, SettingStore<ClientSettingsSchema>>()(
  "hinacode/ClientSettings",
) {}

/** Kept in `<dataDir>/client-settings.json`, except the keybindings, which `keybindings.json` holds on their own. */
export const layer = (dataDir: string) =>
  Layer.effect(
    ClientSettings,
    makeSettingStore(ClientSettingsSchema, defaultClientSettings, {
      path: join(dataDir, "client-settings.json"),
      own: { keybindings: join(dataDir, "keybindings.json") },
    }),
  )
