import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import type { IconType } from "react-icons"
import { RiBrainLine, RiFlashlightLine, RiLockUnlockLine, RiShieldCheckLine, RiShieldUserLine } from "react-icons/ri"
import { type ModelInfo, ProviderId, unlistedModel } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import { AccessMode, type Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, currentBranchAtom, modelsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { type Draft, useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { Button } from "./ui/button.tsx"
import { Input } from "./ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

interface ControlProps {
  readonly thread: Thread
  readonly onError: (message: string) => void
}

const triggerClass =
  "rounded-full border-0 text-xs text-muted-foreground hover:bg-foreground/6 hover:text-foreground dark:bg-transparent dark:hover:bg-foreground/9"

const update = async (patch: RpcRequest<"threads.update">, onError: (message: string) => void) => {
  try {
    useThreads.getState().upsert(await callPromise("threads.update", patch))
  } catch (cause) {
    onError(errorMessage(cause))
  }
}

/** The agent's listed models, plus the thread's own model when the agent no longer lists it. */
function useThreadModels(thread: Thread) {
  const listed = AsyncResult.getOrElse(useAtomValue(modelsAtom(thread.provider)), (): ReadonlyArray<ModelInfo> => [])
  const current = listed.find((model) => model.id === thread.model)
  return current
    ? { models: listed, current }
    : { models: [unlistedModel(thread.model, thread.provider), ...listed], current: undefined }
}

const providerLabel = { claude: m.provider_claude, codex: m.provider_codex } satisfies Record<ProviderId, () => string>

export function AgentPicker({ thread, onError }: ControlProps) {
  const providers = ProviderId.literals.map((id) => ({ value: id, label: providerLabel[id]() }))
  return (
    <Select
      items={providers}
      value={thread.provider}
      onValueChange={(provider) =>
        provider && provider !== thread.provider && update({ id: thread.id, provider }, onError)
      }
    >
      <SelectTrigger size="sm" aria-label={m.thread_agent_picker()} className={triggerClass}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {providers.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <ProviderIcon provider={item.value} />
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ModelPicker({ thread, onError }: ControlProps) {
  const { models } = useThreadModels(thread)
  const items = models.map((model) => ({ value: model.id, label: model.label }))

  // Effort and fast mode the next model cannot honor go back to its defaults.
  const change = (id: string | null) => {
    const next = models.find((model) => model.id === id)
    if (next === undefined || next.id === thread.model) return
    void update(
      {
        id: thread.id,
        model: next.id,
        ...(thread.effort !== null && !next.efforts.includes(thread.effort) ? { effort: null } : {}),
        ...(thread.fastMode && !next.fastMode ? { fastMode: false } : {}),
      },
      onError,
    )
  }

  return (
    <Select items={items} value={thread.model} onValueChange={change}>
      <SelectTrigger size="sm" aria-label={m.thread_model_picker()} className={`min-w-0 flex-1 ${triggerClass}`}>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const effortLabels: Record<string, () => string> = {
  minimal: m.effort_minimal,
  low: m.effort_low,
  medium: m.effort_medium,
  high: m.effort_high,
  xhigh: m.effort_xhigh,
  max: m.effort_max,
  ultra: m.effort_ultra,
}
const effortLabel = (effort: string) => effortLabels[effort]?.() ?? effort

const DEFAULT_EFFORT = "default"

/** Shown only for models with effort control. */
export function EffortPicker({ thread, onError }: ControlProps) {
  const { current } = useThreadModels(thread)
  if (current === undefined || current.efforts.length === 0) return null
  const defaultLabel = current.defaultEffort
    ? m.thread_effort_default_named({ effort: effortLabel(current.defaultEffort) })
    : m.thread_effort_default()
  const items = [
    { value: DEFAULT_EFFORT, label: defaultLabel },
    ...current.efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
  ]

  return (
    <Select
      items={items}
      value={thread.effort ?? DEFAULT_EFFORT}
      onValueChange={(value) => {
        const effort = value === DEFAULT_EFFORT ? null : value
        if (value !== null && effort !== thread.effort) void update({ id: thread.id, effort }, onError)
      }}
    >
      <SelectTrigger size="sm" aria-label={m.thread_effort_picker()} className={triggerClass}>
        <RiBrainLine aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Shown only for models with a fast service tier. */
export function FastModeToggle({ thread, onError }: ControlProps) {
  const { current } = useThreadModels(thread)
  if (!current?.fastMode) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={thread.fastMode}
            onClick={() => void update({ id: thread.id, fastMode: !thread.fastMode }, onError)}
            className="text-xs text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            <RiFlashlightLine aria-hidden />
            {m.thread_fast_mode()}
          </Button>
        }
      />
      <TooltipContent>{m.thread_fast_mode_hint()}</TooltipContent>
    </Tooltip>
  )
}

const accessModes: Record<AccessMode, { readonly icon: IconType; readonly label: () => string }> = {
  supervised: { icon: RiShieldUserLine, label: m.access_supervised },
  auto: { icon: RiShieldCheckLine, label: m.access_auto },
  full: { icon: RiLockUnlockLine, label: m.access_full },
}

/** What each mode lets through, which differs by agent and, for Claude's auto mode, by model. */
const accessHint = (accessMode: AccessMode, thread: Thread, model: ModelInfo | undefined) => {
  switch (accessMode) {
    case "supervised":
      return thread.provider === "codex" ? m.access_supervised_hint_codex() : m.access_supervised_hint_claude()
    case "auto":
      if (thread.provider === "codex") return m.access_auto_hint_codex()
      return model?.autoMode ? m.access_auto_hint_claude() : m.access_auto_hint_claude_edits()
    case "full":
      return m.access_full_hint()
  }
}

/** How much the agent may do without asking. Takes effect from the next turn, or at once on a live Claude turn. */
export function AccessPicker({ thread, onError }: ControlProps) {
  const { current } = useThreadModels(thread)
  const items = AccessMode.literals.map((value) => ({ value, label: accessModes[value].label() }))
  const Icon = accessModes[thread.accessMode].icon

  return (
    <Select
      items={items}
      value={thread.accessMode}
      onValueChange={(accessMode) =>
        accessMode && accessMode !== thread.accessMode && update({ id: thread.id, accessMode }, onError)
      }
    >
      <SelectTrigger
        size="sm"
        aria-label={m.access_picker()}
        data-access={thread.accessMode}
        className={`${triggerClass} data-[access=full]:text-destructive`}
      >
        <Icon aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="w-auto min-w-(--anchor-width)">
        {items.map((item) => {
          const ItemIcon = accessModes[item.value].icon
          return (
            <SelectItem key={item.value} value={item.value}>
              <ItemIcon aria-hidden className="mt-0.5 self-start" />
              <span className="flex flex-col">
                {item.label}
                <span className="text-xs text-muted-foreground">{accessHint(item.value, thread, current)}</span>
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

const workspaces = [
  { value: "local", label: m.thread_workspace_local() },
  { value: "worktree", label: m.thread_workspace_worktree() },
]

/** Where the first turn runs: the project root, or a new worktree forked from a base ref. */
export function WorkspacePicker({ thread, worktree }: { thread: Thread; worktree: Draft["worktree"] }) {
  const currentBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const setWorktree = (next: Draft["worktree"]) => useDrafts.getState().setWorktree(thread.id, next)

  return (
    <div className="mx-auto mt-1 flex max-w-3xl flex-wrap items-center gap-1 px-1 text-xs text-muted-foreground">
      <Select
        items={workspaces}
        value={worktree === null ? "local" : "worktree"}
        onValueChange={(value) => setWorktree(value === "worktree" ? { baseRef: "" } : null)}
      >
        <SelectTrigger size="sm" aria-label={m.thread_workspace_picker()} className={triggerClass}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {worktree !== null && (
        <label className="flex min-w-0 flex-1 items-center gap-1.5">
          {m.thread_base_ref_prefix()}
          <Input
            aria-label={m.thread_base_ref_label()}
            value={worktree.baseRef}
            onChange={(event) => setWorktree({ baseRef: event.target.value })}
            placeholder={currentBranch}
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-48 min-w-0 font-mono text-xs"
          />
        </label>
      )}
    </div>
  )
}
