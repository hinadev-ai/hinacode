import type { ReactNode } from "react"
import type { Worktree } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { WorktreeSetupLog } from "./WorktreeSetupLog.tsx"
import { CheckIcon } from "./icons/CheckIcon.tsx"
import { CircleIcon } from "./icons/CircleIcon.tsx"
import { SpinnerIcon } from "./icons/SpinnerIcon.tsx"

type StepState = "done" | "running" | "pending"

const stepIcon: Record<StepState, ReactNode> = {
  done: <CheckIcon aria-hidden className="size-4 shrink-0 text-success" />,
  running: <SpinnerIcon aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />,
  pending: <CircleIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />,
}

function Step({ state, label, children }: { state: StepState; label: string; children?: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5">{stepIcon[state]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className={state === "pending" ? "text-sm text-muted-foreground" : "text-sm"}>{label}</p>
        {children}
      </div>
    </li>
  )
}

export function WorktreePreparation({ worktree }: { worktree: Worktree }) {
  return (
    <output className="clear-overview m-auto flex w-full max-w-lg flex-col gap-4 px-4">
      <div className="flex flex-col items-center gap-1 text-center">
        <h2 className="text-sm font-semibold">{m.worktree_preparation_title()}</h2>
        <p className="text-sm text-muted-foreground">{m.worktree_preparation_hint()}</p>
      </div>
      <ol className="flex flex-col gap-3.5">
        <Step state="done" label={m.worktree_preparation_create()}>
          <p className="truncate font-mono text-xs text-muted-foreground" title={worktree.path}>
            {worktree.branch} · {worktree.path}
          </p>
        </Step>
        <Step state="running" label={m.worktree_preparation_setup()}>
          <WorktreeSetupLog worktree={worktree} />
        </Step>
        <Step state="pending" label={m.worktree_preparation_send()} />
      </ol>
    </output>
  )
}
