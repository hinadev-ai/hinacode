import { File, Paths } from "expo-file-system"
import * as SecureStore from "expo-secure-store"
import type { RememberedAnswers } from "./connection"
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

/** A server's last lists, which run to hundreds of kilobytes, too big for SecureStore. The OS may clear them. */
const answersFile = (serverId: string) => new File(Paths.cache, `answers-${encodeURIComponent(serverId)}.json`)

/** Null when nothing was saved or the file does not read back, so a launch just waits for the server. */
export async function loadAnswers(serverId: string): Promise<RememberedAnswers | null> {
  try {
    const file = answersFile(serverId)
    return file.exists ? (JSON.parse(await file.text()) as RememberedAnswers) : null
  } catch {
    return null
  }
}

export const saveAnswers = async (serverId: string, answers: RememberedAnswers) =>
  answersFile(serverId).write(JSON.stringify(answers))

export async function clearAnswers(serverId: string) {
  const file = answersFile(serverId)
  if (file.exists) file.delete()
}
