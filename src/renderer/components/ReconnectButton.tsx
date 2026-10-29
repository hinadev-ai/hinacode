import { useAtomSet } from "@effect/atom-react"
import { useTransition } from "react"
import type { Cloud } from "../lib/environments.ts"
import { reconnectEnvironmentAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { Button } from "./ui/button.tsx"

export function ReconnectButton({ cloud }: { cloud: Pick<Cloud, "id" | "status"> }) {
  const reconnect = useAtomSet(reconnectEnvironmentAtom, { mode: "promise" })
  const [pending, startReconnect] = useTransition()
  const busy = pending || cloud.status === "connecting"

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      aria-busy={busy}
      onClick={() =>
        startReconnect(async () => {
          await reconnect(cloud.id).catch(() => undefined)
        })
      }
    >
      {m.environment_reconnect()}
    </Button>
  )
}
