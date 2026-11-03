import { ConductorIcon } from "@hinacode/icons"
import { Link, useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { selectConductor, useThreads } from "../stores/threads.ts"
import { StatusIndicator, useThreadRowState } from "./SidebarThreadList.tsx"
import { Button } from "./ui/button.tsx"

const rowClassName =
  "flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"

export function SidebarConductor() {
  const conductor = useThreads(selectConductor)
  return conductor === undefined ? <StartConductor /> : <ConductorLink conductor={conductor} />
}

function StartConductor() {
  const navigate = useNavigate()
  const start = async () => {
    try {
      const conductor = await callPromise("threads.conductor", undefined)
      useThreads.getState().upsert(conductor)
      await navigate({ to: "/thread/$threadId", params: { threadId: conductor.id } })
    } catch (cause) {
      toast.error(errorMessage(cause))
    }
  }
  return (
    <Button variant="ghost" action={start} className={`${rowClassName} justify-start font-normal`}>
      <ConductorIcon aria-hidden className="size-4 shrink-0" />
      {m.conductor_label()}
    </Button>
  )
}

function ConductorLink({ conductor }: { conductor: Thread }) {
  const state = useThreadRowState(conductor)
  return (
    <Link
      to="/thread/$threadId"
      params={{ threadId: conductor.id }}
      className={`${rowClassName} data-[status=active]:bg-sidebar-accent data-[status=active]:font-medium`}
    >
      <ConductorIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{m.conductor_label()}</span>
      <StatusIndicator state={state} />
    </Link>
  )
}
