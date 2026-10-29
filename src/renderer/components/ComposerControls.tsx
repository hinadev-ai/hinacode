import { Autocomplete } from "@base-ui/react/autocomplete"
import { Toggle } from "@base-ui/react/toggle"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { toast } from "sonner"
import { type KeyboardEvent, useEffect, useId, useRef, useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiChat3Line,
  RiCheckLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiLockUnlockLine,
  RiShieldCheckLine,
  RiShieldUserLine,
} from "react-icons/ri"
import { type ModelInfo, presetModels, ProviderId, unlistedModel } from "../../shared/agent.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import { AccessMode, type OpenPullRequest, type Project, type Thread } from "../../shared/domain.ts"
import { parsePullRequestSelector } from "../../shared/github.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import {
  branchesAtom,
  callPromise,
  currentBranchAtom,
  defaultBranchAtom,
  type EnvironmentId,
  modelsAtom,
  projectsAtom,
  pullRequestsAtom,
} from "../lib/rpc.ts"
import { environmentName, environmentOf, useClouds, useThreadEnvironment } from "../lib/environments.ts"
import { groupProjects } from "../lib/projectGroups.ts"
import { moveUnstartedThread } from "../lib/startThread.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { type Draft, useDrafts } from "../stores/drafts.ts"
import { useThreads } from "../stores/threads.ts"
import { type ComposerPicker, returnFocus, useUi } from "../stores/ui.ts"
import { EffortIcon } from "./icons/EffortIcon.tsx"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { switchAccount, useAccountHint, useAccountOptions } from "./AccountSwitch.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { Input } from "./ui/input.tsx"
import { Kbd, KbdGroup } from "./ui/kbd.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx"
import { Slider } from "./ui/slider.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"
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

/** The agent's listed models, plus `keep`, such as a thread's saved model, when the agent no longer lists it. */
function useAgentModels(environment: EnvironmentId, provider: ProviderId, keep: string | null) {
  const listed = AsyncResult.getOrElse(
    useAtomValue(modelsAtom(environment, provider)),
    (): ReadonlyArray<ModelInfo> => [],
  )
  return keep === null || listed.some((model) => model.id === keep)
    ? listed
    : [unlistedModel(keep, provider), ...listed]
}

/** The thread's model as its agent lists it, or undefined when the agent no longer lists it. */
function useThreadModel(thread: Thread) {
  return useAgentModels(useThreadEnvironment(thread.id), thread.provider, null).find(
    (model) => model.id === thread.model,
  )
}

const sameModel = (a: ModelInfo, b: ModelInfo) => a.provider === b.provider && a.id === b.id

function usePickerModels(environment: EnvironmentId, provider: ProviderId, keep: string | null) {
  return presetModels(
    useAgentModels(environment, provider, keep),
    useSettings(environment).modelPresets[provider],
    keep,
  )
}

const CLI_LOGIN = "cli"

const effortLabels: Record<string, () => string> = {
  minimal: m.effort_minimal,
  low: m.effort_low,
  medium: m.effort_medium,
  high: m.effort_high,
  xhigh: m.effort_xhigh,
  max: m.effort_max,
  ultra: m.effort_ultra,
  ultrathink: m.effort_ultrathink,
  ultracode: m.effort_ultracode,
}
export const effortLabel = (effort: string) => effortLabels[effort]?.() ?? effort

/** Claude Code's ultrathink and ultracode are modes rather than levels, so they say what they do. */
const effortHints: Record<string, () => string> = {
  ultrathink: m.effort_ultrathink_hint,
  ultracode: m.effort_ultracode_hint,
}

const DEFAULT_EFFORT = "default"

/** Where `effort` sits on the model's scale, from 0 to 1, for the effort icon. */
const effortShare = (model: ModelInfo | undefined, effort: string | null) => {
  if (model === undefined || effort === null) return 0
  return (model.efforts.indexOf(effort) + 1) / model.efforts.length
}

export const accessModes: Record<AccessMode, { readonly icon: IconType; readonly label: () => string }> = {
  supervised: { icon: RiShieldUserLine, label: m.access_supervised },
  auto: { icon: RiShieldCheckLine, label: m.access_auto },
  full: { icon: RiLockUnlockLine, label: m.access_full },
}

/** Muse Code's threads use the names its own permission picker shows, since each mode is one of its profiles. */
const museAccessLabels: Record<AccessMode, () => string> = {
  supervised: m.access_supervised_muse,
  auto: m.access_auto_muse,
  full: m.access_full_muse,
}

const accessLabel = (accessMode: AccessMode, provider: ProviderId) =>
  provider === "muse" ? museAccessLabels[accessMode]() : accessModes[accessMode].label()

const supervisedHint = {
  claude: m.access_supervised_hint_claude,
  codex: m.access_supervised_hint_codex,
  muse: m.access_supervised_hint_muse,
} satisfies Record<ProviderId, () => string>

const autoHint = {
  claude: (model: ModelInfo | undefined) =>
    model?.autoMode ? m.access_auto_hint_claude() : m.access_auto_hint_claude_edits(),
  codex: m.access_auto_hint_codex,
  muse: m.access_auto_hint_muse,
} satisfies Record<ProviderId, (model: ModelInfo | undefined) => string>

/** What each mode lets through, which differs by agent and, for Claude's auto mode, by model. */
const accessHint = (accessMode: AccessMode, thread: Thread, model: ModelInfo | undefined) => {
  switch (accessMode) {
    case "supervised":
      return supervisedHint[thread.provider]()
    case "auto":
      return autoHint[thread.provider](model)
    case "full":
      return thread.provider === "muse" ? m.access_full_hint_muse() : m.access_full_hint()
  }
}

/** Muse Code has no way to leave out the user's own skills. */
const hidesUserSkills = { claude: true, codex: true, muse: false } satisfies Record<ProviderId, boolean>

/** A tab of the picker: one account of the thread's agent, or another agent on its default account. */
interface AgentTab {
  readonly value: string
  readonly provider: ProviderId
  /** The account the tab picks, null for the CLI's own login. Undefined leaves the account as it is. */
  readonly accountId?: string | null
  readonly label: string
  readonly hint?: string
  readonly disabled: boolean
}

/** One tab per account of the thread's agent when it has several, then one per other agent. */
function useAgentTabs(thread: Thread, canSwitchAgent: boolean): ReadonlyArray<AgentTab> {
  const accounts = useAccountOptions(thread).options
  const accountHint = useAccountHint()
  // The running turn is still writing the transcript an account switch copies.
  const turnRunning = thread.status === "running" || thread.status === "awaiting_approval"
  const own: ReadonlyArray<AgentTab> =
    accounts.length < 2
      ? [
          {
            value: thread.provider,
            provider: thread.provider,
            label: providerLabel[thread.provider](),
            disabled: false,
          },
        ]
      : accounts.map((option) => ({
          value: `${thread.provider}:${option.id ?? CLI_LOGIN}`,
          provider: thread.provider,
          accountId: option.id,
          label: option.name,
          hint: accountHint(option),
          disabled: turnRunning && option.id !== thread.accountId,
        }))
  const others = ProviderId.literals
    .filter((provider) => provider !== thread.provider)
    .map((provider) => ({ value: provider, provider, label: providerLabel[provider](), disabled: !canSwitchAgent }))
  return [...own, ...others]
}

const isThreadTab = (tab: AgentTab, thread: Thread) =>
  tab.provider === thread.provider && (tab.accountId === undefined || tab.accountId === thread.accountId)

/**
 * The thread's agent, account, model, effort, modes and access in one popover. Picking another agent's model
 * switches the agent; a started thread continues on it with the conversation handed over.
 */
export function ThreadPicker({ thread, canSwitchAgent, onError }: ControlProps & { canSwitchAgent: boolean }) {
  const environment = useThreadEnvironment(thread.id)
  const current = useThreadModel(thread)
  const selected = current ?? unlistedModel(thread.model, thread.provider)
  const tabs = useAgentTabs(thread, canSwitchAgent)
  const threadTab = tabs.find((tab) => isThreadTab(tab, thread))?.value ?? thread.provider
  const [open, setOpen] = useState(false)
  const [tabValue, setTabValue] = useState(threadTab)
  const [focus, setFocus] = useState<ComposerPicker>("model")
  const openedByShortcut = useRef(false)
  const closedWithEnter = useRef(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const tab = tabs.find((candidate) => candidate.value === tabValue) ?? tabs[0]!
  const models = usePickerModels(environment, tab.provider, tab.provider === thread.provider ? thread.model : null)
  const set = (patch: Omit<RpcRequest<"threads.update">, "id">) => void update({ ...patch, id: thread.id }, onError)

  const show = (picker: ComposerPicker) => {
    closedWithEnter.current = false
    setFocus(picker)
    setTabValue(threadTab)
    setOpen(true)
  }

  // The model and effort shortcuts open the same popover, focused on what they name.
  useEffect(
    () =>
      useUi.subscribe((state, previous) => {
        const request = state.pickerRequest
        if (request === previous.pickerRequest || request === null) return
        openedByShortcut.current = true
        closedWithEnter.current = false
        setFocus(request.picker)
        setTabValue(threadTab)
        setOpen(true)
      }),
    [threadTab],
  )

  // Another agent starts from its own defaults. On the same agent, effort and fast mode the next model
  // cannot honor go back to its defaults.
  const pick = async (next: ModelInfo) => {
    if (tab.provider !== thread.provider) {
      await update({ id: thread.id, provider: next.provider, model: next.id }, onError)
      return
    }
    if (tab.accountId !== undefined && tab.accountId !== thread.accountId) {
      try {
        await switchAccount(thread.id, tab.accountId)
      } catch (cause) {
        onError(errorMessage(cause))
        return
      }
    }
    if (sameModel(next, selected)) return
    await update(
      {
        id: thread.id,
        model: next.id,
        ...(thread.effort !== null && !next.efforts.includes(thread.effort) ? { effort: null } : {}),
        ...(thread.fastMode && !next.fastMode ? { fastMode: false } : {}),
      },
      onError,
    )
  }

  const moveTab = (step: number) => {
    const enabled = tabs.filter((candidate) => !candidate.disabled)
    const next = enabled[(enabled.indexOf(tab) + step + enabled.length) % enabled.length]
    if (next === undefined) return
    // The focused model row unmounts with the old tab's list, which would take focus, and these keys, out of the popup.
    popupRef.current?.focus()
    setTabValue(next.value)
  }
  const efforts = current === undefined || current.efforts.length === 0 ? [] : [DEFAULT_EFFORT, ...current.efforts]
  /** The value `step` places from `value` in `values`, wrapping at both ends. */
  const stepThrough = <V,>(values: ReadonlyArray<V>, value: V, step: number) =>
    values[(values.indexOf(value) + step + values.length) % values.length]!
  const stepEffort =
    efforts.length === 0
      ? null
      : (step: number) => {
          const next = stepThrough(efforts, thread.effort ?? DEFAULT_EFFORT, step)
          set({ effort: next === DEFAULT_EFFORT ? null : next })
        }
  const toggleFast = current?.fastMode ? () => set({ fastMode: !thread.fastMode }) : null
  const toggleConversation = hidesUserSkills[thread.provider] ? () => set({ userSkills: !thread.userSkills }) : null
  const stepAccess = (step: number) => set({ accessMode: stepThrough(AccessMode.literals, thread.accessMode, step) })
  /**
   * Single keys drive the whole popover: H and L move between agents, digits pick a model, E and M step effort and
   * access forward, and with Shift back.
   */
  const keys: Record<string, ((step: number) => void) | null> = {
    h: () => moveTab(-1),
    l: () => moveTab(1),
    e: stepEffort,
    f: toggleFast,
    c: toggleConversation,
    m: stepAccess,
    enter: () => {
      closedWithEnter.current = true
      setOpen(false)
    },
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const digit = Number(event.key)
    const model = !event.shiftKey && digit >= 1 && digit <= 9 && !tab.disabled ? models[digit - 1] : undefined
    const action = model ? () => void pick(model) : keys[event.key.toLowerCase()]
    if (!action) return
    event.preventDefault()
    action(event.shiftKey ? -1 : 1)
  }

  const effort = thread.effort ?? current?.defaultEffort ?? null
  const summary = [
    selected.label,
    effort === null ? null : effortLabel(effort),
    thread.fastMode ? m.thread_fast_mode() : null,
    thread.accessMode === "full" ? accessLabel("full", thread.provider) : null,
  ].filter((part) => part !== null)
  const AccessIcon = accessModes[thread.accessMode].icon

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          openedByShortcut.current = false
          show("model")
        } else setOpen(false)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={m.thread_option_value({ name: m.thread_model_picker(), value: summary.join(", ") })}
            className={cn("min-w-0", triggerClass)}
          />
        }
      >
        <ProviderIcon provider={thread.provider} />
        <span className="min-w-0 truncate text-foreground">{selected.label}</span>
        {effort !== null && <span className="shrink-0">{effortLabel(effort)}</span>}
        {thread.fastMode && <RiFlashlightLine aria-hidden className="shrink-0" />}
        {thread.accessMode === "full" && <AccessIcon aria-hidden className="shrink-0 text-destructive" />}
      </PopoverTrigger>
      <PopoverContent
        ref={popupRef}
        side="top"
        align="start"
        sideOffset={6}
        className="max-h-(--available-height) w-80 max-w-[calc(100vw-1rem)] gap-3 p-2"
        initialFocus={() =>
          (focus === "effort"
            ? popupRef.current?.querySelector<HTMLElement>("[data-slot=slider-thumb] input")
            : popupRef.current) ?? true
        }
        // Enter means the settings are done, so the message is next.
        finalFocus={() => {
          if (!closedWithEnter.current) return openedByShortcut.current ? returnFocus() : true
          useUi.getState().requestComposerFocus()
          return false
        }}
        onKeyDown={onKeyDown}
      >
        <Tabs
          value={tab.value}
          changeAction={(value) => setTabValue(String(value))}
          className="-mx-2 gap-1 border-b border-border px-2 pb-2"
        >
          <div className="flex items-center gap-2">
            <TabsList className="min-w-0 justify-start overflow-x-auto bg-transparent p-0 [scrollbar-width:none]">
              {tabs.map((candidate) => (
                <Tooltip key={candidate.value}>
                  <TooltipTrigger
                    render={
                      <TabsTrigger value={candidate.value} disabled={candidate.disabled} className="flex-none px-2" />
                    }
                  >
                    <ProviderIcon provider={candidate.provider} />
                    {/* An agent's icon names it; accounts of one agent share the icon, so they keep their names. */}
                    <span className={candidate.accountId === undefined ? "sr-only" : "max-w-28 truncate"}>
                      {candidate.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{candidate.label}</TooltipContent>
                </Tooltip>
              ))}
            </TabsList>
            <KbdGroup aria-hidden className="ml-auto">
              <Kbd>H</Kbd>
              <Kbd>L</Kbd>
            </KbdGroup>
          </div>
          {tab.hint && <p className="px-1 text-xs text-muted-foreground tabular-nums">{tab.hint}</p>}
        </Tabs>
        <ul
          aria-label={m.thread_model_picker()}
          className="scroll-fade-y flex max-h-72 min-h-0 flex-col gap-0.5 overflow-y-auto"
        >
          {models.map((model, index) => {
            const isSelected = isThreadTab(tab, thread) && sameModel(model, selected)
            return (
              <li key={model.id}>
                <button
                  type="button"
                  disabled={tab.disabled}
                  aria-pressed={isSelected}
                  data-selected={isSelected}
                  onClick={() => void pick(model)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-50 aria-pressed:font-medium"
                >
                  <span className="min-w-0 flex-1 truncate">{model.label}</span>
                  {index < 9 && <Kbd aria-hidden>{index + 1}</Kbd>}
                  <RiCheckLine aria-hidden className={cn("size-4 shrink-0", !isSelected && "invisible")} />
                </button>
              </li>
            )
          })}
        </ul>
        <div className="flex flex-col gap-3 border-t border-border px-1 pt-3">
          {current !== undefined && current.efforts.length > 0 && (
            <EffortSlider
              key={`${current.id}:${thread.effort ?? DEFAULT_EFFORT}`}
              model={current}
              value={thread.effort ?? DEFAULT_EFFORT}
              onCommit={(value) => set({ effort: value === DEFAULT_EFFORT ? null : value })}
            />
          )}
          <div className="flex flex-wrap items-center justify-end gap-1.5 empty:hidden">
            {toggleFast && (
              <ModeToggle
                icon={RiFlashlightLine}
                label={m.thread_fast_mode()}
                hint={m.thread_fast_mode_hint()}
                shortcut="F"
                on={thread.fastMode}
                toggle={toggleFast}
              />
            )}
            {toggleConversation && (
              <ModeToggle
                icon={RiChat3Line}
                label={m.thread_conversation_mode()}
                hint={m.thread_conversation_mode_hint()}
                shortcut="C"
                on={!thread.userSkills}
                toggle={toggleConversation}
              />
            )}
          </div>
          <AccessSwitch thread={thread} model={current} onChange={(accessMode) => set({ accessMode })} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface EffortSliderProps {
  readonly model: ModelInfo
  readonly value: string
  readonly onCommit: (value: string) => void
}

/** Steps from the agent's default up to the model's strongest effort. Saves once the thumb is let go. */
function EffortSlider({ model, value, onCommit }: EffortSliderProps) {
  const labelId = useId()
  const steps = [
    {
      value: DEFAULT_EFFORT,
      label: model.defaultEffort
        ? m.thread_effort_default_named({ effort: effortLabel(model.defaultEffort) })
        : m.thread_effort_default(),
    },
    ...model.efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
  ]
  const [index, setIndex] = useState(
    Math.max(
      0,
      steps.findIndex((step) => step.value === value),
    ),
  )
  const step = steps[index]!
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span id={labelId} className="text-muted-foreground">
          {m.thread_effort_picker()}
        </span>
        <span className="ml-auto truncate font-medium">{step.label}</span>
        <EffortIcon
          value={effortShare(model, step.value === DEFAULT_EFFORT ? (model.defaultEffort ?? null) : step.value)}
          className="size-4 shrink-0"
        />
        <Kbd aria-hidden className="h-4 min-w-4">
          E
        </Kbd>
      </div>
      <Slider
        aria-labelledby={labelId}
        value={index}
        min={0}
        max={steps.length - 1}
        step={1}
        getAriaValueText={(_formatted, next) => steps[next]?.label ?? ""}
        onValueChange={(next) => setIndex(next)}
        onValueCommitted={(next) => steps[next]!.value !== value && onCommit(steps[next]!.value)}
      />
      {effortHints[step.value] && <p className="text-xs text-muted-foreground">{effortHints[step.value]!()}</p>}
    </div>
  )
}

interface ModeToggleProps {
  readonly icon: IconType
  readonly label: string
  readonly hint: string
  readonly shortcut: string
  readonly on: boolean
  readonly toggle: () => void
}

function ModeToggle({ icon: Icon, label, hint, shortcut, on, toggle }: ModeToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-pressed={on}
            onClick={toggle}
            className="text-muted-foreground aria-pressed:border-transparent aria-pressed:bg-accent aria-pressed:text-foreground"
          >
            <Icon aria-hidden />
            {label}
            <Kbd aria-hidden className="-mr-1 h-4 min-w-4">
              {shortcut}
            </Kbd>
          </Button>
        }
      />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

/** Takes effect from the next turn, or at once on a live Claude turn. */
function AccessSwitch({
  thread,
  model,
  onChange,
}: {
  thread: Thread
  model: ModelInfo | undefined
  onChange: (accessMode: AccessMode) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <ToggleGroup
        aria-label={m.access_picker()}
        value={[thread.accessMode]}
        onValueChange={(values) => {
          const next = values[0]
          if (next !== undefined && next !== thread.accessMode) onChange(next)
        }}
        className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5"
      >
        {AccessMode.literals.map((value) => {
          const Icon = accessModes[value].icon
          return (
            <Toggle
              key={value}
              value={value}
              data-destructive={value === "full" || undefined}
              className="flex min-w-0 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-sm data-destructive:data-pressed:text-destructive"
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{accessLabel(value, thread.provider)}</span>
            </Toggle>
          )
        })}
      </ToggleGroup>
      <div className="flex items-start gap-2 px-0.5">
        <p className="flex-1 text-xs text-pretty text-muted-foreground">
          {accessHint(thread.accessMode, thread, model)}
        </p>
        <Kbd aria-hidden>M</Kbd>
      </div>
    </div>
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

/** Free text for the workspace's ref, suggesting the repository's open pull requests and branches. */
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

const contextWord =
  "rounded-sm underline decoration-muted-foreground/60 decoration-dotted decoration-2 underline-offset-[0.2em]"

interface ContextOption {
  readonly projectId: string
  readonly label: string
}

/**
 * A dotted word in a new thread's question. With alternatives it opens a menu, and picking one moves the unstarted
 * thread to that project; without any it stays plain text.
 */
function ContextSwitch({
  thread,
  label,
  options,
}: {
  thread: Thread
  label: string
  options: ReadonlyArray<ContextOption>
}) {
  const navigate = useNavigate()
  const [isMoving, startMoving] = useTransition()
  if (options.length < 2) return <span className={contextWord}>{label}</span>
  const move = (projectId: string) =>
    startMoving(async () => {
      try {
        await moveUnstartedThread(thread, projectId, navigate)
      } catch (cause) {
        toast.error(errorMessage(cause))
      }
    })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={isMoving}
        className={cn(
          contextWord,
          "cursor-pointer outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        )}
      >
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-auto min-w-44">
        <DropdownMenuRadioGroup
          value={thread.projectId}
          onValueChange={(projectId: string) => projectId !== thread.projectId && move(projectId)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.projectId} value={option.projectId} closeOnClick>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A new thread's project, switchable to another project on the same machine. */
export function ThreadProjectSwitch({ thread }: { thread: Thread }) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const current = projects.find((project) => project.id === thread.projectId)
  const options = projects
    .filter((project) => project.kind !== "chats" && environmentOf(project) === environmentOf(current))
    .map((project) => ({ projectId: project.id, label: project.name }))
  return <ContextSwitch thread={thread} label={current?.name ?? ""} options={options} />
}

/** The machine a new thread runs on, switchable to another machine that has the same repository, or its chats. */
export function ThreadEnvironmentSwitch({ thread }: { thread: Thread }) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const clouds = useClouds()
  const environment = environmentOf(projects.find((project) => project.id === thread.projectId))
  const members =
    groupProjects(projects).find((group) => group.projects.some((project) => project.id === thread.projectId))
      ?.projects ?? []
  const options = members.map((project) => ({
    projectId: project.id,
    label: environmentName(environmentOf(project), clouds),
  }))
  // Mid-sentence, this machine reads in lower case; a remote keeps its own name.
  const label = environment === null ? m.environment_this_machine_inline() : environmentName(environment, clouds)
  return <ContextSwitch thread={thread} label={label} options={options} />
}

/**
 * Where the first turn runs: the project root, switched to a branch or pull request on send, or a new worktree
 * forked from a branch or checked out from a pull request.
 */
export function WorkspacePicker({ thread, workspace }: { thread: Thread; workspace: Draft["workspace"] }) {
  const currentBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const defaultBranch = AsyncResult.getOrElse(useAtomValue(defaultBranchAtom(thread.projectId)), () => "main")
  const setWorkspace = (next: Draft["workspace"]) => useDrafts.getState().setWorkspace(thread.id, next)
  const mode = workspace?.mode ?? "local"
  const ref = workspace?.ref ?? currentBranch
  const RefIcon = parsePullRequestSelector(ref) ? RiGitPullRequestLine : RiGitBranchLine

  return (
    <div className="mx-auto mt-1 flex w-full max-w-3xl items-center gap-1 px-1">
      <fieldset
        aria-label={m.thread_workspace_picker()}
        className="flex h-7 min-w-0 items-center rounded-full border border-border text-xs text-muted-foreground"
      >
        <div className="flex min-w-0 items-center gap-1.5 pr-2 pl-2.5">
          <RefIcon aria-hidden className="size-3.5 shrink-0" />
          <RefInput projectId={thread.projectId} value={ref} onChange={(next) => setWorkspace({ mode, ref: next })} />
        </div>
        <div aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <label className="flex h-full cursor-pointer items-center gap-1.5 rounded-r-full pr-3 pl-2 hover:text-foreground">
          <Checkbox
            checked={mode === "worktree"}
            onCheckedChange={(checked) => setWorkspace(checked ? { mode: "worktree", ref: defaultBranch } : null)}
          />
          {m.thread_worktree_toggle()}
        </label>
      </fieldset>
    </div>
  )
}
