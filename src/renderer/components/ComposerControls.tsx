import { Autocomplete } from "@base-ui/react/autocomplete"
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import type { IconType } from "react-icons"
import {
  RiBrainLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiLockUnlockLine,
  RiShieldCheckLine,
  RiShieldUserLine,
  RiUserLine,
} from "react-icons/ri"
import { type ModelInfo, ProviderId, unlistedModel } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import { AccessMode, type OpenPullRequest, type Thread } from "../../shared/domain.ts"
import { parsePullRequestSelector } from "../../shared/github.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import {
  branchesAtom,
  callPromise,
  currentBranchAtom,
  defaultBranchAtom,
  modelsAtom,
  pullRequestsAtom,
} from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { type Draft, useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { ProviderIcon } from "./ProviderIcon.tsx"
import { useProviderAccounts } from "./settings/AccountSettings.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
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

/**
 * Composer pickers sit at the bottom of the window, so their popups open upward and hang off the
 * trigger's left edge. Aligning the selected row with the trigger (the Select default) leaves only
 * the rows that fit between the trigger and the window edge, about three, floating over the composer.
 */
const composerPopup = {
  side: "top",
  align: "start",
  sideOffset: 6,
  alignItemWithTrigger: false,
  className: "max-h-[min(24rem,var(--available-height))] w-auto min-w-(--anchor-width)",
} as const

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
      <SelectContent {...composerPopup}>
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
      <SelectTrigger size="sm" aria-label={m.thread_model_picker()} className={`min-w-24 ${triggerClass}`}>
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent {...composerPopup}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const CLI_LOGIN = "cli"

/**
 * Which account the thread bills to. Shown only when the agent has an added account, and fixed once the
 * thread has a session, because the session's transcript lives in that account's home.
 */
export function AccountPicker({ thread, onError }: ControlProps) {
  const accounts = useProviderAccounts(thread.provider)
  if (accounts.length === 0) return null
  const items = [
    { value: CLI_LOGIN, label: m.account_cli_login() },
    ...accounts.map((account) => ({ value: account.id, label: account.name })),
  ]
  const current = thread.accountId ?? CLI_LOGIN

  return (
    <Select
      items={items}
      value={current}
      disabled={thread.providerSessionId !== null}
      onValueChange={(value) =>
        value !== null &&
        value !== current &&
        update({ id: thread.id, accountId: value === CLI_LOGIN ? null : value }, onError)
      }
    >
      <SelectTrigger size="sm" aria-label={m.account_picker()} className={triggerClass}>
        <RiUserLine aria-hidden />
        <SelectValue />
      </SelectTrigger>
      <SelectContent {...composerPopup}>
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
      <SelectContent {...composerPopup}>
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

export const accessModes: Record<AccessMode, { readonly icon: IconType; readonly label: () => string }> = {
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
      <SelectContent {...composerPopup}>
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

type RefSuggestion =
  | { readonly kind: "pullRequest"; readonly ref: string; readonly pullRequest: OpenPullRequest }
  | { readonly kind: "branch"; readonly ref: string }

const SUGGESTIONS_PER_GROUP = 20

/**
 * Open pull requests, then branches, filtered by the field's text. When the text is exactly one of the
 * suggestions, such as the default branch prefilled by ticking Worktree, every suggestion shows instead.
 */
function useRefSuggestions(projectId: string, query: string) {
  const branches = AsyncResult.getOrElse(useAtomValue(branchesAtom(projectId)), (): ReadonlyArray<string> => [])
  const pullRequests = AsyncResult.getOrElse(
    useAtomValue(pullRequestsAtom(projectId)),
    (): ReadonlyArray<OpenPullRequest> => [],
  )

  return useMemo(() => {
    const groups = [
      {
        label: m.thread_worktree_ref_pull_requests(),
        items: pullRequests.map((pullRequest): RefSuggestion => ({
          kind: "pullRequest",
          ref: `#${pullRequest.number}`,
          pullRequest,
        })),
      },
      {
        label: m.thread_worktree_ref_branches(),
        items: branches.map((branch): RefSuggestion => ({ kind: "branch", ref: branch })),
      },
    ]
    const trimmed = query.trim()
    const needle = trimmed.toLowerCase()
    const showAll = groups.some((group) => group.items.some((item) => item.ref === trimmed))
    const matches = (item: RefSuggestion) =>
      (item.kind === "pullRequest" ? `${item.ref} ${item.pullRequest.title} ${item.pullRequest.headRefName}` : item.ref)
        .toLowerCase()
        .includes(needle)
    return groups
      .map((group) => ({
        ...group,
        items: (showAll ? group.items : group.items.filter(matches)).slice(0, SUGGESTIONS_PER_GROUP),
      }))
      .filter((group) => group.items.length > 0)
  }, [branches, pullRequests, query])
}

function RefSuggestionItem({ suggestion }: { suggestion: RefSuggestion }) {
  return (
    <Autocomplete.Item
      value={suggestion}
      className="flex h-7 cursor-default items-center gap-2 rounded-md px-2 text-xs outline-none select-none [scroll-margin-block:0.25rem] data-highlighted:bg-accent data-highlighted:text-accent-foreground"
    >
      {suggestion.kind === "pullRequest" ? (
        <>
          <RiGitPullRequestLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 font-mono">{suggestion.ref}</span>
          <span className="min-w-0 truncate">{suggestion.pullRequest.title}</span>
          {suggestion.pullRequest.isDraft && (
            <span className="ml-auto shrink-0 text-muted-foreground">{m.thread_worktree_ref_draft()}</span>
          )}
        </>
      ) : (
        <>
          <RiGitBranchLine aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono">{suggestion.ref}</span>
        </>
      )}
    </Autocomplete.Item>
  )
}

/** Free text for a new worktree's ref, suggesting the repository's open pull requests and branches. */
function RefInput({
  projectId,
  value,
  onChange,
}: {
  projectId: string
  value: string
  onChange: (ref: string) => void
}) {
  const groups = useRefSuggestions(projectId, value)
  const [open, setOpen] = useState(false)

  return (
    <Autocomplete.Root
      items={groups}
      filter={null}
      value={value}
      onValueChange={(next, details) => {
        // Escape on a closed list would clear the field; it should only dismiss.
        if (details.reason !== "escape-key") onChange(next)
      }}
      open={open && groups.length > 0}
      onOpenChange={setOpen}
      openOnInputClick
      itemToStringValue={(suggestion: RefSuggestion) => suggestion.ref}
    >
      <Autocomplete.Input
        aria-label={m.thread_worktree_ref_label()}
        placeholder={m.thread_worktree_ref_placeholder()}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          // The field sits inside the composer's form, where Enter would send the message.
          if (event.key === "Enter") event.preventDefault()
        }}
        render={
          <Input className="field-sizing-content h-6 max-w-96 min-w-16 rounded-sm border-0 px-1 font-mono text-xs text-foreground shadow-none focus-visible:ring-2 md:text-xs dark:bg-transparent" />
        }
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner side="top" align="start" sideOffset={6} collisionPadding={8} className="isolate z-50">
          <Autocomplete.Popup className="max-h-[min(20rem,var(--available-height))] w-96 max-w-(--available-width) origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[opacity,scale] duration-150 ease-(--ease-out) data-ending-style:scale-97 data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-97 data-starting-style:opacity-0 motion-reduce:transition-none">
            <Autocomplete.List className="scroll-py-1">
              {(group: (typeof groups)[number]) => (
                <Autocomplete.Group key={group.label} items={group.items} className="not-last:mb-1">
                  <Autocomplete.GroupLabel className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground select-none">
                    {group.label}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(suggestion: RefSuggestion) => <RefSuggestionItem key={suggestion.ref} suggestion={suggestion} />}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}

/** Where the first turn runs: the project root, or a new worktree forked from a branch or checked out from a PR. */
export function WorkspacePicker({ thread, worktree }: { thread: Thread; worktree: Draft["worktree"] }) {
  const currentBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const defaultBranch = AsyncResult.getOrElse(useAtomValue(defaultBranchAtom(thread.projectId)), () => "main")
  const setWorktree = (next: Draft["worktree"]) => useDrafts.getState().setWorktree(thread.id, next)
  const RefIcon = worktree && parsePullRequestSelector(worktree.ref) ? RiGitPullRequestLine : RiGitBranchLine

  return (
    <div className="mx-auto mt-1 flex w-full max-w-3xl px-1">
      <fieldset
        aria-label={m.thread_workspace_picker()}
        className="flex h-7 min-w-0 items-center rounded-full border border-border text-xs text-muted-foreground"
      >
        <div className="flex min-w-0 items-center gap-1.5 pr-2 pl-2.5">
          <RefIcon aria-hidden className="size-3.5 shrink-0" />
          {worktree === null ? (
            <span className="truncate font-mono text-foreground">{currentBranch}</span>
          ) : (
            <RefInput projectId={thread.projectId} value={worktree.ref} onChange={(ref) => setWorktree({ ref })} />
          )}
        </div>
        <div aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <label className="flex h-full cursor-pointer items-center gap-1.5 rounded-r-full pr-3 pl-2 hover:text-foreground">
          <Checkbox
            checked={worktree !== null}
            onCheckedChange={(checked) => setWorktree(checked ? { ref: defaultBranch } : null)}
          />
          {m.thread_worktree_toggle()}
        </label>
      </fieldset>
    </div>
  )
}
