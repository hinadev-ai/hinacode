import { Outlet, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { tinykeys } from "tinykeys"
import { Sidebar } from "./Sidebar.tsx"

export function AppShell() {
  const navigate = useNavigate()

  useEffect(() => tinykeys(window, { "$mod+Comma": () => void navigate({ to: "/settings" }) }), [navigate])

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  )
}
