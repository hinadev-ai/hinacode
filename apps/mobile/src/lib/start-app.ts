import NetInfo, { type NetInfoState } from "@react-native-community/netinfo"
import * as Linking from "expo-linking"
import { AppState } from "react-native"
import { parsePairingUrl, type PairingTarget } from "@shared/remote.ts"
import {
  networkChanged,
  onEvent,
  onRemembered,
  restoreAnswers,
  setForeground,
  setServers,
  setWatching,
  storedServers,
  useConnection,
} from "@/lib/connection"
import { clearAnswers, loadAnswers, loadServers, saveAnswers, saveServers } from "@/lib/storage"
import { addPairing, newServerId } from "@/lib/stored-target"
import { isTranscriptPush, useMessages } from "@/stores/messages"
import { usePreferences } from "@/stores/preferences"
import { usePullRequests } from "@/stores/pull-requests"
import { useRelayAccount } from "@/stores/relay-account"
import { useSubagents } from "@/stores/subagents"
import { useThreads } from "@/stores/threads"
import { useVms } from "@/stores/vms"

export function pair(target: PairingTarget) {
  const { servers, id } = addPairing(storedServers(), target, newServerId)
  setServers(servers)
  return id
}

export function forgetServer(id: string) {
  setServers(storedServers().filter((server) => server.id !== id))
  if (useConnection.getState().servers.length === 0) return
  void useThreads.getState().load()
  void usePullRequests.getState().load()
}

let started: Promise<void> | undefined

export const startApp = () => (started ??= start())

async function start() {
  followForeground()
  const [servers] = await Promise.all([loadServers(), usePreferences.getState().restore()])
  if (useConnection.getState().servers.length === 0) {
    setServers(servers)
    void showLastLists(servers.map((server) => server.id))
  }
  saveServerChanges()
  onRemembered((serverId, answers) => void saveAnswers(serverId, answers))
  void useRelayAccount.getState().restore()
  followNetwork()
  routePushes()
  followConnection()
  useMessages.subscribe((state, previous) => {
    if (state.watched !== previous.watched) setWatching([...state.watched])
  })
  pairFromLinks()
}

function saveServerChanges() {
  let saved = storedServers()
  useConnection.subscribe(() => {
    const next = storedServers()
    if (JSON.stringify(next) === JSON.stringify(saved)) return
    for (const { id } of saved) if (!next.some((server) => server.id === id)) void clearAnswers(id)
    saved = next
    void saveServers(next)
  })
}

function followForeground() {
  setForeground(AppState.currentState !== "background")
  AppState.addEventListener("change", (state) => {
    if (state === "active" || state === "background") setForeground(state === "active")
    if (state === "active") void useRelayAccount.getState().sync()
  })
}

function followNetwork() {
  let network: string | null = null
  NetInfo.addEventListener((state) => {
    const next = networkIdentity(state)
    if (network !== null && next !== network && state.isConnected !== false) networkChanged()
    network = next
  })
}

function routePushes() {
  onEvent((event) => {
    if (isTranscriptPush(event)) useMessages.getState().receive(event)
    else if (event.type === "thread.updated" && event.thread.sideOf === null) useThreads.getState().upsert(event.thread)
    else if (event.type === "thread.removed") useThreads.getState().remove(event.id)
    else if (event.type === "worktree.updated") useThreads.getState().upsertWorktree(event.worktree)
    else if (event.type === "thread.pullRequests") usePullRequests.getState().replace(event.threadId, event.links)
    else if (event.type === "thread.subagents") useSubagents.getState().replace(event.threadId, event.subagents)
    else if (event.type === "vm.updated") useVms.getState().replace(event.threadId, event.vm)
  })
}

function followConnection() {
  useConnection.subscribe((state, previous) => {
    if (state.generation !== previous.generation && state.generation !== 0) {
      void useThreads.getState().load()
      void usePullRequests.getState().load()
      useMessages.getState().reload()
      useSubagents.getState().reload()
      useVms.getState().reload()
    }
    if (state.paired !== previous.paired) {
      useMessages.getState().reset()
      useSubagents.getState().reset()
      useVms.getState().reset()
    }
  })
}

function pairFromLinks() {
  const pairFrom = (url: string | null) => {
    const target = url === null ? null : parsePairingUrl(url)
    if (target !== null) pair(target)
  }
  void Linking.getInitialURL().then(pairFrom)
  Linking.addEventListener("url", ({ url }) => pairFrom(url))
}

async function showLastLists(serverIds: readonly string[]) {
  const saved = await Promise.all(serverIds.map(loadAnswers))
  serverIds.forEach((id, index) => {
    const answers = saved[index]
    if (answers) restoreAnswers(id, answers)
  })
  if (!saved.some(Boolean) || useThreads.getState().status === "ready") return
  void useThreads.getState().load()
  void usePullRequests.getState().load()
}

const networkIdentity = (state: NetInfoState) =>
  [state.type, state.isConnected, state.details !== null && "ipAddress" in state.details ? state.details.ipAddress : ""].join(
    "|",
  )
