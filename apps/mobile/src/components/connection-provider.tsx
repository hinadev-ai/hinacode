import { useURL } from "expo-linking"
import { type ReactNode, useEffect, useState } from "react"
import { AppState } from "react-native"
import { parsePairingUrl, type PairingTarget } from "@shared/remote.ts"
import { connect, onEvent, reconnectNow, useConnection } from "@/lib/connection"
import { loadTarget, saveTarget } from "@/lib/storage"
import { isTranscriptPush, useMessages } from "@/stores/messages"
import { useThreads } from "@/stores/threads"

export async function pair(target: PairingTarget) {
  await saveTarget(target)
  connect(target)
}

/**
 * Restores the stored pairing, accepts `kkcode://connect` links, and keeps the thread and message
 * stores in step with the one socket. Renders nothing until storage has been read.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [restored, setRestored] = useState(false)
  const status = useConnection((state) => state.status)
  const url = useURL()

  useEffect(() => {
    void loadTarget().then((target) => {
      if (target !== null && useConnection.getState().target === null) connect(target)
      setRestored(true)
    })
  }, [])

  useEffect(() => {
    const target = url === null ? null : parsePairingUrl(url)
    if (target !== null) void pair(target)
  }, [url])

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => state === "active" && reconnectNow())
    return () => subscription.remove()
  }, [])

  useEffect(
    () =>
      onEvent((event) => {
        if (isTranscriptPush(event)) useMessages.getState().receive(event)
        else if (event.type === "thread.updated") useThreads.getState().upsert(event.thread)
        else if (event.type === "thread.removed") useThreads.getState().remove(event.id)
      }),
    [],
  )

  useEffect(() => {
    if (status === "connected") void useThreads.getState().load()
    else useMessages.getState().reset()
  }, [status])

  return restored ? children : null
}
