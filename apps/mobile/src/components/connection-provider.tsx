import { RegistryContext } from "@effect/atom-react"
import { type ReactNode, Suspense, use } from "react"
import { registry } from "@/lib/remote"
import { startApp } from "@/lib/start-app"

export function ConnectionProvider({ children }: { children: ReactNode }) {
  return (
    <RegistryContext value={registry}>
      <Suspense fallback={null}>
        <Started>{children}</Started>
      </Suspense>
    </RegistryContext>
  )
}

function Started({ children }: { children: ReactNode }) {
  use(startApp())
  return children
}
