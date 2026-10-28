import { Autocomplete } from "@base-ui/react/autocomplete"
import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useLayoutEffect, useRef, useState, useTransition } from "react"
import type { IconType } from "react-icons"
import {
  RiBrainLine,
  RiChat3Line,
  RiCloudLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiGitPullRequestLine,
  RiLockUnlockLine,
  RiMacbookLine,
  RiMoreLine,
  RiShieldCheckLine,
  RiShieldUserLine,
  RiUserLine,
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
import { type ComposerPicker, useUi } from "../stores/ui.ts"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { switchAccount, useAccountHint, useAccountOptions } from "./AccountSwitch.tsx"
import { Button } from "./ui/button.tsx"
import { Checkbox } from "./ui/checkbox.tsx"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { Input } from "./ui/input.tsx"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./ui/select.tsx"
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

/**
 * Open state for a picker, which `picker`'s shortcut also opens. Opened by the shortcut, it hands focus back
 * to where it was, usually the message box, instead of to its trigger. Spread `root` on the Select and
 * `popup` on its content.
 */
function usePickerOpen(picker: ComposerPicker | undefined) {
  const [open, setOpen] = useState(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(
    () =>
      useUi.subscribe((state, previous) => {
        if (state.pickerRequest === previous.pickerRequest || state.pickerRequest?.picker !== picker) return
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        setOpen(true)
      }),
    [picker],
  )
  const onOpenChange = (next: boolean) => {
    if (next) returnFocus.current = null
    setOpen(next)
  }
  return {
    root: { open, onOpenChange },
    popup: { finalFocus: () => returnFocus.current ?? true },
  }
}

const sameModel = (a: ModelInfo, b: ModelInfo) => a.provider === b.provider && a.id === b.id

/**
 * The thread's model, listed under its agent. Every agent is listed unless a turn runs, and picking another agent's
 * model switches the agent; a started thread continues on it with the conversation handed over.
 */
export function ModelPicker({ thread, canSwitchAgent, onError }: ControlProps & { canSwitchAgent: boolean }) {
  const environment = useThreadEnvironment(thread.id)
  const selected = useThreadModel(thread) ?? unlistedModel(thread.model, thread.provider)
  const providers = canSwitchAgent ? ProviderId.literals : [thread.provider]
  const pickerOpen = usePickerOpen("model")

  // Another agent starts from its own defaults. On the same agent, effort and fast mode the next model
  // cannot honor go back to its defaults.
  const change = (next: ModelInfo | null) => {
    if (next === null || sameModel(next, selected)) return
    void update(
      next.provider === thread.provider
        ? {
            id: thread.id,
            model: next.id,
            ...(thread.effort !== null && !next.efforts.includes(thread.effort) ? { effort: null } : {}),
            ...(thread.fastMode && !next.fastMode ? { fastMode: false } : {}),
          }
        : { id: thread.id, provider: next.provider, model: next.id },
      onError,
    )
  }

  return (
    <Select
      {...pickerOpen.root}
      value={selected}
      onValueChange={change}
      isItemEqualToValue={sameModel}
      itemToStringLabel={(model: ModelInfo) => model.label}
    >
      <SelectTrigger size="sm" aria-label={m.thread_model_picker()} className={cn("min-w-0", triggerClass)}>
        <ProviderIcon provider={thread.provider} />
        <SelectValue className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent {...composerPopup} {...pickerOpen.popup}>
        {providers.map((provider) => (
          <ModelGroup
            key={provider}
            environment={environment}
            provider={provider}
            keep={provider === thread.provider ? thread.model : null}
          />
        ))}
      </SelectContent>
    </Select>
  )
}

function usePickerModels(environment: EnvironmentId, provider: ProviderId, keep: string | null) {
  return presetModels(
    useAgentModels(environment, provider, keep),
    useSettings(environment).modelPresets[provider],
    keep,
  )
}

interface ModelGroupProps {
  readonly environment: EnvironmentId
  readonly provider: ProviderId
  readonly keep: string | null
}

function ModelGroup({ environment, provider, keep }: ModelGroupProps) {
  const models = usePickerModels(environment, provider, keep)
  if (models.length === 0) return null
  return (
    <SelectGroup>
      <SelectLabel className="flex items-center gap-1.5">
        <ProviderIcon provider={provider} />
        {providerLabel[provider]()}
      </SelectLabel>
      {models.map((model) => (
        <SelectItem key={model.id} value={model}>
          {model.label}
        </SelectItem>
      ))}
    </SelectGroup>
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

interface ChoiceItem<V extends string> {
  readonly value: V
  readonly label: string
  readonly icon?: IconType
  readonly hint?: string
}

/** A thread setting picked from a list: a select on the toolbar, or a submenu of More options. */
interface Choice<V extends string = string> {
  readonly name: string
  /** Stands for the current value when its label does not fit. */
  readonly icon: IconType
  readonly value: V
  readonly items: ReadonlyArray<ChoiceItem<V>>
  readonly disabled: boolean
  /** Full access runs every command unchecked, so it keeps the destructive color wherever it shows. */
  readonly destructive: boolean
  readonly onChange: (value: V) => void
}

/** A thread setting that is on or off: a pressed button on the toolbar, or a checkbox in More options. */
interface Toggle {
  readonly label: string
  readonly hint: string
  readonly icon: IconType
  readonly on: boolean
  readonly toggle: () => void
}

/** Muse Code has no way to leave out the user's own skills. */
const hidesUserSkills = { claude: true, codex: true, muse: false } satisfies Record<ProviderId, boolean>

/** The settings beside the model, each shown only when the agent, account or model supports it. */
function useThreadOptions(thread: Thread, onError: (message: string) => void) {
  const current = useThreadModel(thread)
  const accounts = useAccountOptions(thread).options
  const accountHint = useAccountHint()
  const set = (patch: Omit<RpcRequest<"threads.update">, "id">) => void update({ ...patch, id: thread.id }, onError)

  const account: Choice | null =
    accounts.length < 2
      ? null
      : {
          name: m.account_picker(),
          icon: RiUserLine,
          value: thread.accountId ?? CLI_LOGIN,
          items: accounts.map((option) => ({
            value: option.id ?? CLI_LOGIN,
            label: option.name,
            hint: accountHint(option),
          })),
          // The running turn is still writing the transcript the switch copies.
          disabled: thread.status === "running" || thread.status === "awaiting_approval",
          destructive: false,
          onChange: (value) =>
            void switchAccount(thread.id, value === CLI_LOGIN ? null : value).catch((cause: unknown) =>
              onError(errorMessage(cause)),
            ),
        }

  const effort: Choice | null =
    current === undefined || current.efforts.length === 0
      ? null
      : {
          name: m.thread_effort_picker(),
          icon: RiBrainLine,
          value: thread.effort ?? DEFAULT_EFFORT,
          items: [
            {
              value: DEFAULT_EFFORT,
              label: current.defaultEffort
                ? m.thread_effort_default_named({ effort: effortLabel(current.defaultEffort) })
                : m.thread_effort_default(),
            },
            ...current.efforts.map((value) => ({ value, label: effortLabel(value), hint: effortHints[value]?.() })),
          ],
          disabled: false,
          destructive: false,
          onChange: (value) => set({ effort: value === DEFAULT_EFFORT ? null : value }),
        }

  const fast: Toggle | null = current?.fastMode
    ? {
        label: m.thread_fast_mode(),
        hint: m.thread_fast_mode_hint(),
        icon: RiFlashlightLine,
        on: thread.fastMode,
        toggle: () => set({ fastMode: !thread.fastMode }),
      }
    : null

  const conversation: Toggle | null = hidesUserSkills[thread.provider]
    ? {
        label: m.thread_conversation_mode(),
        hint: m.thread_conversation_mode_hint(),
        icon: RiChat3Line,
        on: !thread.userSkills,
        toggle: () => set({ userSkills: !thread.userSkills }),
      }
    : null

  // Takes effect from the next turn, or at once on a live Claude turn.
  const access: Choice<AccessMode> = {
    name: m.access_picker(),
    icon: accessModes[thread.accessMode].icon,
    value: thread.accessMode,
    items: AccessMode.literals.map((value) => ({
      value,
      label: accessLabel(value, thread.provider),
      icon: accessModes[value].icon,
      hint: accessHint(value, thread, current),
    })),
    disabled: false,
    destructive: thread.accessMode === "full",
    onChange: (accessMode) => set({ accessMode }),
  }

  return { account, effort, toggles: [fast, conversation].filter((toggle) => toggle !== null), access }
}

/**
 * Tries labels, then icons, and settles on the first whose row fits the slot, else on the More options menu.
 * Children restyle from the slot's `data-fit`, so each try costs a layout, not a render.
 */
const fitOptions = (slot: HTMLElement, row: HTMLElement) => {
  for (const fit of ["labels", "icons"]) {
    slot.dataset.fit = fit
    if (row.getBoundingClientRect().width <= slot.getBoundingClientRect().width) return
  }
  slot.dataset.fit = "menu"
}

/**
 * Account, effort, fast mode, conversation mode and access, shown with labels, else as icons, else in a More
 * options menu, whichever fits beside the model picker. It is measured, not set at breakpoints, because the
 * width the labels need changes with the model, the chosen values and the language.
 */
export function ThreadOptions({ thread, onError }: ControlProps) {
  const { account, effort, toggles, access } = useThreadOptions(thread, onError)
  const slotRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)

  // After every render, because another value or model changes how wide the labels are.
  useLayoutEffect(() => {
    if (slotRef.current && rowRef.current) fitOptions(slotRef.current, rowRef.current)
  })

  useLayoutEffect(() => {
    const slot = slotRef.current
    const row = rowRef.current
    if (!slot || !row) return undefined
    const fit = () => fitOptions(slot, row)
    const observer = new ResizeObserver(fit)
    observer.observe(slot)
    // A label also changes width when its font finishes loading, which resizes nothing else.
    document.fonts.addEventListener("loadingdone", fit)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener("loadingdone", fit)
    }
  }, [])

  // A trigger whose popup is open stays shown when the fit changes: a hidden one would leave its modal popup
  // open over nothing, blocking every click.
  return (
    <div ref={slotRef} className="flex min-w-7 flex-1">
      <div
        ref={rowRef}
        className="flex shrink-0 items-center gap-1.5 in-data-[fit=menu]:hidden in-data-[fit=menu]:has-data-popup-open:flex"
      >
        {account && <ChoiceSelect choice={account} />}
        {effort && <ChoiceSelect choice={effort} picker="effort" />}
        {toggles.map((toggle) => (
          <ToggleButton key={toggle.label} toggle={toggle} />
        ))}
        <ChoiceSelect choice={access} />
      </div>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.thread_options_more()}
                    data-destructive={access.destructive || undefined}
                    className={cn(
                      triggerClass,
                      "hidden in-data-[fit=menu]:inline-flex data-popup-open:inline-flex data-destructive:text-destructive",
                    )}
                  />
                }
              >
                <RiMoreLine aria-hidden />
              </DropdownMenuTrigger>
            }
          />
          <TooltipContent>{m.thread_options_more()}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="top" className="w-auto min-w-48">
          {account && <ChoiceSubmenu choice={account} />}
          {effort && <ChoiceSubmenu choice={effort} />}
          {toggles.map(({ label, icon: Icon, on, toggle }) => (
            <DropdownMenuCheckboxItem key={label} checked={on} onCheckedChange={toggle} closeOnClick>
              <Icon aria-hidden />
              {label}
            </DropdownMenuCheckboxItem>
          ))}
          <ChoiceSubmenu choice={access} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** In the icons fit the label and chevron go; screen readers still read the value. */
const iconOnly =
  "in-data-[fit=icons]:w-7 in-data-[fit=icons]:justify-center in-data-[fit=icons]:px-0 in-data-[fit=icons]:*:data-[slot=select-icon]:hidden in-data-[fit=icons]:*:data-[slot=select-value]:sr-only"

function ChoiceSelect<V extends string>({ choice, picker }: { choice: Choice<V>; picker?: ComposerPicker }) {
  const pickerOpen = usePickerOpen(picker)
  const Icon = choice.icon
  const label = choice.items.find((item) => item.value === choice.value)?.label ?? choice.value
  return (
    <Select
      {...pickerOpen.root}
      items={choice.items}
      value={choice.value}
      disabled={choice.disabled}
      onValueChange={(value) => value !== null && value !== choice.value && choice.onChange(value)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              size="sm"
              aria-label={choice.name}
              data-destructive={choice.destructive || undefined}
              className={cn(triggerClass, iconOnly, "data-destructive:text-destructive")}
            >
              <Icon aria-hidden />
              <SelectValue />
            </SelectTrigger>
          }
        />
        <TooltipContent>{m.thread_option_value({ name: choice.name, value: label })}</TooltipContent>
      </Tooltip>
      <SelectContent {...composerPopup} {...pickerOpen.popup}>
        {choice.items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <ChoiceItemLabel item={item} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function ChoiceSubmenu<V extends string>({ choice }: { choice: Choice<V> }) {
  const Icon = choice.icon
  const label = choice.items.find((item) => item.value === choice.value)?.label
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        disabled={choice.disabled}
        data-destructive={choice.destructive || undefined}
        className="data-destructive:text-destructive"
      >
        <Icon aria-hidden />
        {choice.name}
        <span className={cn("flex-1 pl-6 text-right", !choice.destructive && "text-muted-foreground")}>{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={choice.value}
          onValueChange={(value: V) => value !== choice.value && choice.onChange(value)}
        >
          {choice.items.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value} closeOnClick>
              <ChoiceItemLabel item={item} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function ChoiceItemLabel({ item }: { item: ChoiceItem<string> }) {
  if (item.icon === undefined && item.hint === undefined) return item.label
  const Icon = item.icon
  return (
    <>
      {Icon && <Icon aria-hidden className="mt-0.5 self-start" />}
      <span className="flex flex-col">
        {item.label}
        <span className="text-xs text-muted-foreground tabular-nums">{item.hint}</span>
      </span>
    </>
  )
}

function ToggleButton({ toggle }: { toggle: Toggle }) {
  const Icon = toggle.icon
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={toggle.on}
            onClick={toggle.toggle}
            className="text-xs text-muted-foreground aria-pressed:bg-accent aria-pressed:text-foreground in-data-[fit=icons]:w-7 in-data-[fit=icons]:px-0 in-data-[fit=icons]:[&>span]:sr-only"
          >
            <Icon aria-hidden />
            <span>{toggle.label}</span>
          </Button>
        }
      />
      <TooltipContent>{toggle.hint}</TooltipContent>
    </Tooltip>
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

const environmentIcon = (project: Project | undefined) =>
  environmentOf(project) === null ? RiMacbookLine : RiCloudLine

/**
 * The machine the thread runs on, among those its project's group spans. Picking another moves the unstarted thread
 * there. Hidden when the repository is on one machine only.
 */
export function EnvironmentPicker({ thread, onError }: ControlProps) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const clouds = useClouds()
  const navigate = useNavigate()
  const [isMoving, startMoving] = useTransition()
  const members = groupProjects(projects).find((group) =>
    group.projects.some((project) => project.id === thread.projectId),
  )?.projects
  if (members === undefined || members.length < 2) return null

  const choice: Choice = {
    name: m.thread_environment_picker(),
    icon: environmentIcon(members.find((project) => project.id === thread.projectId)),
    value: thread.projectId,
    items: members.map((project) => ({
      value: project.id,
      label: environmentName(environmentOf(project), clouds),
      icon: environmentIcon(project),
    })),
    disabled: isMoving,
    destructive: false,
    onChange: (projectId) =>
      startMoving(async () => {
        try {
          await moveUnstartedThread(thread, projectId, navigate)
        } catch (cause) {
          onError(errorMessage(cause))
        }
      }),
  }
  return <ChoiceSelect choice={choice} />
}

/**
 * Where the first turn runs: the project root, switched to a branch or pull request on send, or a new worktree
 * forked from a branch or checked out from a pull request.
 */
export function WorkspacePicker({ thread, workspace, onError }: ControlProps & { workspace: Draft["workspace"] }) {
  const currentBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const defaultBranch = AsyncResult.getOrElse(useAtomValue(defaultBranchAtom(thread.projectId)), () => "main")
  const setWorkspace = (next: Draft["workspace"]) => useDrafts.getState().setWorkspace(thread.id, next)
  const mode = workspace?.mode ?? "local"
  const ref = workspace?.ref ?? currentBranch
  const RefIcon = parsePullRequestSelector(ref) ? RiGitPullRequestLine : RiGitBranchLine

  return (
    <div className="mx-auto mt-1 flex w-full max-w-3xl items-center gap-1 px-1">
      <EnvironmentPicker thread={thread} onError={onError} />
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
