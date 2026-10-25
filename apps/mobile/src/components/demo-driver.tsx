import { router } from "expo-router"
import { useEffect } from "react"
import { useThreads } from "@/stores/threads"

export function DemoDriver() {
  const id = useThreads((state) =>
    state.status === "ready" ? Object.values(state.byId).sort((a, b) => a.title.localeCompare(b.title))[0]?.id : undefined,
  )
  useEffect(() => {
    const delay = Number(process.env.EXPO_PUBLIC_DEMO_THREAD_DELAY ?? 0)
    if (id === undefined || !delay) return
    const timer = setTimeout(() => router.push(`/thread/${id}`), delay)
    return () => clearTimeout(timer)
  }, [id])
  return null
}
