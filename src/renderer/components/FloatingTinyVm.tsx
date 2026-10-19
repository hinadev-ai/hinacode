import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { Suspense, useRef, useState } from "react"
import { RiFullscreenLine, RiPictureInPictureExitLine } from "react-icons/ri"
import { callPromise, threadVmAtom } from "../lib/rpc.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { useUi, VM_FLOATING_BOUNDS } from "../stores/ui.ts"
import { ResizeHandle } from "./ResizeHandle.tsx"
import {
  ControlButton,
  ControlStatus,
  IconAction,
  PasskeyButton,
  PasskeyNotice,
  type RunningVm,
  ScreenFallback,
  ScreenshotButton,
  showVmFullscreen,
  TinyVmScreen,
  useVmAction,
  useVmDrop,
} from "./sidePanel/TinyVmView.tsx"

/** The thread's tiny VM screen floating over the top right of the conversation, when the user floated it. */
export function FloatingTinyVm({ threadId }: { threadId: string }) {
  const { experimental } = useSettings(useThreadEnvironment(threadId))
  const floating = useUi((state) => state.vmPlacements[threadId] === "floating")
  if (!experimental.tinyVm || !floating) return null
  return <WhenRunning threadId={threadId} />
}

function WhenRunning({ threadId }: { threadId: string }) {
  const vm = useAtomValue(threadVmAtom(threadId))
  if (!AsyncResult.isSuccess(vm) || vm.value.status !== "running") return null
  return <FloatingScreen threadId={threadId} vm={vm.value} />
}

function FloatingScreen({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const { pending, error, run } = useVmAction()
  const { dropping, onDropFiles } = useVmDrop(threadId, run)
  const { experimental } = useSettings(useThreadEnvironment(threadId))
  const width = useUi((state) => state.vmFloatingWidth)
  const setWidth = useUi((state) => state.setVmFloatingWidth)
  const setPlacement = useUi((state) => state.setVmPlacement)
  // The find bar runs along the top of the transcript, so the screen moves below it.
  const findOpen = useUi((state) => state.findThreadId === threadId)
  const ref = useRef<HTMLDivElement>(null)
  const [attempt, setAttempt] = useState(0)
  const waiting = vm.control === "user" && vm.agentWaiting
  const control = <ControlButton threadId={threadId} vm={vm} pending={pending} run={run} />

  return (
    <div
      ref={ref}
      style={{ width }}
      className={cn("absolute right-4 z-10 max-w-[calc(100%-2rem)]", findOpen ? "top-13" : "top-3")}
    >
      <ResizeHandle
        label={m.vm_floating_resize()}
        edge="left"
        targetRef={ref}
        bounds={VM_FLOATING_BOUNDS}
        onResize={setWidth}
        onReset={() => setWidth(null)}
      />
      <section
        aria-label={m.panel_tab_tiny_vm()}
        className={cn(
          "flex flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg",
          vm.control === "user" && "outline-2 outline-offset-2 outline-working",
          waiting && "border-attention",
        )}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border pr-1 pl-2.5">
          <ControlStatus vm={vm} />
          {control}
          <ScreenshotButton threadId={threadId} run={run} />
          {experimental.tinyVmPasskeys && <PasskeyButton threadId={threadId} run={run} />}
          <IconAction icon={RiFullscreenLine} label={m.vm_fullscreen()} onClick={() => showVmFullscreen(threadId)} />
          <IconAction
            icon={RiPictureInPictureExitLine}
            label={m.vm_dock()}
            onClick={() => setPlacement(threadId, "panel")}
          />
        </div>
        {error && (
          <p role="alert" className="border-b border-border px-2.5 py-1 text-xs text-destructive">
            {error}
          </p>
        )}
        {experimental.tinyVmPasskeys && <PasskeyNotice threadId={threadId} run={run} />}
        <Suspense fallback={<ScreenFallback />}>
          <TinyVmScreen
            key={`${vm.sandboxId}:${attempt}`}
            threadId={threadId}
            control={vm.control}
            bare
            fullscreenControls={control}
            onHandBack={() => run(() => callPromise("vm.control", { threadId, control: "agent" }))}
            onReconnect={() => setAttempt((count) => count + 1)}
            onDropFiles={onDropFiles}
            dropping={dropping}
          />
        </Suspense>
      </section>
    </div>
  )
}
