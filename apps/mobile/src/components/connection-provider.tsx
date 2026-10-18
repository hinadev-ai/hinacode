import NetInfo, { type NetInfoState } from "@react-native-community/netinfo"
import { useURL } from "expo-linking"
import { type ReactNode, useEffect, useState } from "react"
import { AppState } from "react-native"
import { parsePairingUrl, type PairingTarget } from "@shared/remote.ts"
import { connect, networkChanged, onEvent, setForeground, useConnection } from "@/lib/connection"
import { loadTarget, saveTarget } from "@/lib/storage"
import { isTranscriptPush, useMessages } from "@/stores/messages"
import { usePreferences } from "@/stores/preferences"
import { usePullRequests } from "@/stores/pull-requests"
import { useThreads } from "@/stores/threads"

export async function pair(target: PairingTarget) {
  await saveTarget(target)
  connect(target)
}

/**
 * Restores the stored pairing and preferences, accepts `hinacode://connect` links, and keeps the thread,
 * message and pull request stores in step with the one socket. Renders nothing until storage has been read.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [restored, setRestored] = useState(false)
  const generation = useConnection((state) => state.generation)
  const target = useConnection((state) => state.target)
  const paired = useConnection((state) => state.target !== null && state.status !== "unauthorized")
  const url = useURL()

  useEffect(() => {
    void Promise.all([loadTarget(), usePreferences.getState().restore()]).then(([target]) => {
      if (target !== null && useConnection.getState().target === null) connect(target)
      setRestored(true)
    })
  }, [])

  useEffect(() => {
    const target = url === null ? null : parsePairingUrl(url)
    if (target !== null) void pair(target)
  }, [url])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" || state === "background") setForeground(state === "active")
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

  useEffect(() => () => useMessages.getState().reset(), [paired, target])

  return restored ? children : null
}

const networkIdentity = (state: NetInfoState) =>
  [state.type, state.isConnected, state.details !== null && "ipAddress" in state.details ? state.details.ipAddress : ""].join(
    "|",
  )
