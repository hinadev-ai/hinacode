import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { type ModelInfo, ProviderId, unlistedModel } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import type { Thread } from "../../shared/domain.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, currentBranchAtom, modelsAtom } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { type Draft, useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { Input } from "./ui/input.tsx"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx"

interface ControlProps {
  readonly thread: Thread
  readonly onError: (message: string) => void
}

const triggerClass = "border-0 text-xs"

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
  return listed.some((model) => model.id === thread.model)
    ? listed
    : [unlistedModel(thread.model, thread.provider), ...listed]
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
  const models = useThreadModels(thread)
  const items = models.map((model) => ({ value: model.id, label: model.label }))

  const change = (model: string | null) => {
    if (model !== null && model !== thread.model) void update({ id: thread.id, model }, onError)
  }

  return (
    <Select items={items} value={thread.model} onValueChange={change}>
      <SelectTrigger size="sm" aria-label={m.thread_model_picker()} className={triggerClass}>
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

const workspaces = [
  { value: "local", label: m.thread_workspace_local() },
  { value: "worktree", label: m.thread_workspace_worktree() },
]

/** Where the first turn runs: the project root, or a new worktree forked from a base ref. */
export function WorkspacePicker({ thread, worktree }: { thread: Thread; worktree: Draft["worktree"] }) {
  const currentBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const setWorktree = (next: Draft["worktree"]) => useDrafts.getState().setWorktree(thread.id, next)

  return (
    <div className="mx-auto mt-1 flex max-w-3xl items-center gap-1 px-1 text-xs text-muted-foreground">
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
        <label className="flex items-center gap-1.5">
          {m.thread_base_ref_prefix()}
          <Input
            aria-label={m.thread_base_ref_label()}
            value={worktree.baseRef}
            onChange={(event) => setWorktree({ baseRef: event.target.value })}
            placeholder={currentBranch}
            spellCheck={false}
            autoComplete="off"
            className="h-7 w-48 font-mono text-xs"
          />
        </label>
      )}
    </div>
  )
}
