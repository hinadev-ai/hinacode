import { parseRelayAccount, RELAY_ACCOUNT_KEY, type RelayAccount } from "./relay-account"
import { parsePreferences, PREFERENCES_KEY, type Preferences } from "./preferences"
import { LEGACY_KEY, newServerId, parseStoredServers, SERVERS_KEY, type StoredServer } from "./stored-target"

export async function loadServers() {
  const legacy = localStorage.getItem(LEGACY_KEY)
  const servers = parseStoredServers(localStorage.getItem(SERVERS_KEY), legacy, newServerId)
  if (legacy !== null) {
    await saveServers(servers)
    localStorage.removeItem(LEGACY_KEY)
  }
  return servers
}

export const saveServers = async (servers: readonly StoredServer[]) =>
  localStorage.setItem(SERVERS_KEY, JSON.stringify(servers))

export const loadPreferences = async () => parsePreferences(localStorage.getItem(PREFERENCES_KEY))

export const savePreferences = async (preferences: Preferences) =>
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))

export const loadRelayAccount = async () => parseRelayAccount(localStorage.getItem(RELAY_ACCOUNT_KEY))

export const saveRelayAccount = async (account: RelayAccount) =>
  localStorage.setItem(RELAY_ACCOUNT_KEY, JSON.stringify(account))

export const clearRelayAccount = async () => localStorage.removeItem(RELAY_ACCOUNT_KEY)
