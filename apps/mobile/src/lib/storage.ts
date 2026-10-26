import * as SecureStore from "expo-secure-store"
import { parseRelayAccount, RELAY_ACCOUNT_KEY, type RelayAccount } from "./relay-account"
import { parsePreferences, PREFERENCES_KEY, type Preferences } from "./preferences"
import { LEGACY_KEY, newServerId, parseStoredServers, SERVERS_KEY, type StoredServer } from "./stored-target"

export async function loadServers() {
  const [raw, legacy] = await Promise.all([SecureStore.getItemAsync(SERVERS_KEY), SecureStore.getItemAsync(LEGACY_KEY)])
  const servers = parseStoredServers(raw, legacy, newServerId)
  if (legacy !== null) {
    await saveServers(servers)
    await SecureStore.deleteItemAsync(LEGACY_KEY)
  }
  return servers
}

export const saveServers = (servers: readonly StoredServer[]) =>
  SecureStore.setItemAsync(SERVERS_KEY, JSON.stringify(servers))

export const loadPreferences = async () => parsePreferences(await SecureStore.getItemAsync(PREFERENCES_KEY))

export const savePreferences = (preferences: Preferences) =>
  SecureStore.setItemAsync(PREFERENCES_KEY, JSON.stringify(preferences))

export const loadRelayAccount = async () => parseRelayAccount(await SecureStore.getItemAsync(RELAY_ACCOUNT_KEY))

export const saveRelayAccount = (account: RelayAccount) =>
  SecureStore.setItemAsync(RELAY_ACCOUNT_KEY, JSON.stringify(account))

export const clearRelayAccount = () => SecureStore.deleteItemAsync(RELAY_ACCOUNT_KEY)
