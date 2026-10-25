import NetInfo, { type NetInfoState } from "@react-native-community/netinfo"
import { useURL } from "expo-linking"
import { type ReactNode, useEffect, useState } from "react"
import { AppState } from "react-native"
import { parsePairingUrl, type PairingTarget } from "@shared/remote.ts"
import { networkChanged, onEvent, setForeground, setServers, storedServers, useConnection } from "@/lib/connection"
import { loadServers, saveServers } from "@/lib/storage"
import { addPairing, newServerId } from "@/lib/stored-target"
import { isTranscriptPush, useMessages } from "@/stores/messages"
import { usePreferences } from "@/stores/preferences"
import { usePullRequests } from "@/stores/pull-requests"
import { useRelayAccount } from "@/stores/relay-account"
import { useThreads } from "@/stores/threads"

/** Adds a server, or updates the one this pairing reaches again. Returns its id. */
export function pair(target: PairingTarget) {
  const { servers, id } = addPairing(storedServers(), target, newServerId)
  setServers(servers)
  return id
}

/** Unpairs one server. Its projects and threads leave the lists. */
export function forgetServer(id: string) {
  setServers(storedServers().filter((server) => server.id !== id))
  if (useConnection.getState().servers.length === 0) return
  void useThreads.getState().load()
  void usePullRequests.getState().load()
}

/**
 * Restores the paired servers and preferences, syncs with the relay account at launch and on every return to the
 * foreground, saves the server list whenever it changes, accepts `hinacode://connect` links, and keeps the thread,
 * message and pull request stores in step with every server's socket. Renders nothing until storage has been read.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [restored, setRestored] = useState(false)
  const generation = useConnection((state) => state.generation)
  const paired = useConnection((state) => state.paired)
  const url = useURL()

  useEffect(() => {
    let cancelled = false
    let unsubscribe = () => {}
    void Promise.all([loadServers(), usePreferences.getState().restore()]).then(([servers]) => {
      if (cancelled) return
      if (useConnection.getState().servers.length === 0) setServers(servers)
      let saved = JSON.stringify(storedServers())
      unsubscribe = useConnection.subscribe(() => {
        const next = storedServers()
        if (JSON.stringify(next) === saved) return
        saved = JSON.stringify(next)
        void saveServers(next)
      })
      setRestored(true)
      void useRelayAccount.getState().restore()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const demo = process.env.EXPO_PUBLIC_DEMO_PAIR
    const target = url !== null ? parsePairingUrl(url) : demo ? parsePairingUrl(demo) : null
    if (target !== null && restored) pair(target)
  }, [url, restored])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" || state === "background") setForeground(state === "active")
      if (state === "active") void useRelayAccount.getState().sync()
    })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    // The first callback reports the network the app started on.
    let network: string | null = null
    return NetInfo.addEventListener((state) => {
      const next = networkIdentity(state)
      if (network !== null && next !== network && state.isConnected !== false) networkChanged()
      network = next
    })
  }, [])

  useEffect(
    () =>
      onEvent((event) => {
        if (isTranscriptPush(event)) useMessages.getState().receive(event)
        else if (event.type === "thread.updated") useThreads.getState().upsert(event.thread)
        else if (event.type === "thread.removed") useThreads.getState().remove(event.id)
        else if (event.type === "worktree.updated") useThreads.getState().upsertWorktree(event.worktree)
        else if (event.type === "thread.pullRequests") usePullRequests.getState().replace(event.threadId, event.links)
      }),
    [],
  )

  useEffect(() => {
    if (generation === 0) return
    void useThreads.getState().load()
    void usePullRequests.getState().load()
    useMessages.getState().reload()
  }, [generation])

  useEffect(() => () => useMessages.getState().reset(), [paired])

  return restored ? children : null
}

const networkIdentity = (state: NetInfoState) =>
  [state.type, state.isConnected, state.details !== null && "ipAddress" in state.details ? state.details.ipAddress : ""].join(
    "|",
  )
