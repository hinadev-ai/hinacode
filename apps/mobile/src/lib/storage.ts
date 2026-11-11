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

// FIXME: a server's last lists run to hundreds of kilobytes, too big for SecureStore, so they live in the OS cache.
const answersFile = (serverId: string) => new File(Paths.cache, `answers-${encodeURIComponent(serverId)}.json`)

export async function loadAnswers(serverId: string): Promise<RememberedAnswers | null> {
  try {
    const file = answersFile(serverId)
    return file.exists ? (JSON.parse(await file.text()) as RememberedAnswers) : null
  } catch {
    return null
  }
}

const answerWrites = new Map<string, Promise<void>>()

// FIXME: expo-file-system rejects one of two writes that both find no file, so writes queue per server.
export function saveAnswers(serverId: string, answers: RememberedAnswers) {
  const write = (answerWrites.get(serverId) ?? Promise.resolve())
    .then(() => answersFile(serverId).write(JSON.stringify(answers)))
    .catch(() => {})
  answerWrites.set(serverId, write)
  return write
}

export async function clearAnswers(serverId: string) {
  const file = answersFile(serverId)
  if (file.exists) file.delete()
}
