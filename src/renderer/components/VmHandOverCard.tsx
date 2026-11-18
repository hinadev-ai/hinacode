import { useAtomValue } from "@effect/atom-react"
import { ComputerIcon, PipExitIcon } from "@hinacode/icons"
import { AsyncResult } from "effect/reactivity"
import { startTransition, Suspense, useState } from "react"
import { toolArgument } from "../../shared/agent.ts"
import type { MessagePart } from "../../shared/domain.ts"
import { callPromise, threadVmAtom } from "../lib/rpc.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { useUi } from "../stores/ui.ts"
import { Highlighted } from "./FindHighlight.tsx"
import {
  ControlButton,
  ControlStatus,
  IconAction,
  type RunningVm,
  ScreenFallback,
  useVmAction,
  useVmDrop,
  VmScreen,
  vmScreenId,
  vmScreenKind,
} from "./sidePanel/TinyVmView.tsx"

type ToolCall = Extract<MessagePart, { type: "tool_call" }>

const openVmPanel = (threadId: string) => useUi.getState().showView(threadId, "tinyVm")

export function VmHandOverCard({ threadId, call }: { threadId: string; call: ToolCall }) {
  const vm = useAtomValue(threadVmAtom(threadId))
  const argument = toolArgument(call.input, "request")
  const request = typeof argument === "string" ? argument : ""
  const waiting = call.status === "running"
  const live =
    waiting &&
    AsyncResult.isSuccess(vm) &&
    vm.value.status === "running" &&
    vm.value.control === "user" &&
    vmScreenKind(vm.value) === "noVnc"

  if (live) return <LiveHandOver threadId={threadId} vm={vm.value} />
  return (
    <button
      type="button"
      onClick={() => openVmPanel(threadId)}
      aria-label={m.vm_hand_over_open({ request })}
      className={cn(
        "my-2 flex w-full max-w-md min-w-0 items-center gap-3.5 rounded-xl p-2.5 pe-4 text-start pressable outline-none focus-visible:ring-2 focus-visible:ring-ring",
        waiting ? "bg-attention/10 hover:bg-attention/15" : "bg-muted/50 hover:bg-muted",
      )}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg bg-background ring-1 ring-foreground/10 dark:bg-foreground/8",
          waiting ? "text-attention" : "text-muted-foreground",
        )}
      >
        <ComputerIcon aria-hidden className="size-5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-xs", waiting ? "font-medium text-attention" : "text-muted-foreground")}>
          {waiting ? m.vm_hand_over_waiting() : m.vm_hand_over_done()}
        </span>
        <span dir="auto" className="line-clamp-2 text-sm text-pretty" title={request}>
          <Highlighted text={request} />
        </span>
      </span>
    </button>
  )
}

function LiveHandOver({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const { pending, error, run } = useVmAction()
  const drop = useVmDrop(threadId, run)
  const [attempt, setAttempt] = useState(0)

  return (
    <section
      aria-label={m.panel_tab_tiny_vm()}
      className="my-2 flex w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-attention bg-background"
    >
      <div className="flex min-h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
        <ControlStatus vm={vm} />
        <ControlButton threadId={threadId} vm={vm} pending={pending} run={run} />
        <IconAction icon={PipExitIcon} label={m.vm_dock()} onClick={() => openVmPanel(threadId)} />
      </div>
      {error && (
        <p role="alert" className="border-b border-border px-3 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <Suspense fallback={<ScreenFallback />}>
        <VmScreen
          key={`${vm.sandboxId}:${attempt}`}
          threadId={threadId}
          vm={vm}
          bare
          screenId={`${vmScreenId(threadId)}-hand-over`}
          onHandBack={() => run(() => callPromise("vm.control", { threadId, control: "agent" }))}
          onReconnect={() => startTransition(() => setAttempt((count) => count + 1))}
          drop={drop}
        />
      </Suspense>
    </section>
  )
}
