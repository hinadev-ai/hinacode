import { RiGitPullRequestLine } from "react-icons/ri"
import { Autocomplete } from "@base-ui/react/autocomplete"
import { Combobox } from "@base-ui/react/combobox"
import { Toggle } from "@base-ui/react/toggle"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { toast } from "sonner"
import {
  type KeyboardEvent,
  type ReactNode,
  startTransition,
  use,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useTransition,
} from "react"
import { flushSync } from "react-dom"
import { type ModelInfo, presetModels, ProviderId, unlistedModel } from "../../shared/agent.ts"
import { type AccessBehavior, accessBehavior } from "../../shared/access.ts"
import type { RpcRequest } from "../../shared/contract.ts"
import { AccessMode, enabledProviders, type OpenPullRequest, type Project, type Thread } from "../../shared/domain.ts"
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
  setUpProvidersAtom,
} from "../lib/rpc.ts"
import { environmentName, environmentOf, useClouds, useThreadEnvironment } from "../lib/environments.ts"
import { inBrowser } from "../lib/runtime.ts"
import { ProjectDialog } from "./ProjectDialog.tsx"
import { groupProjects } from "../../shared/projectGroups.ts"
import { moveDraft } from "../lib/startThread.ts"
import { useInstalledProviders, useSettings } from "../lib/settings.ts"
import { useAltHeld } from "../lib/useModifierHeld.ts"
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
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx"
import { Input } from "./ui/input.tsx"
import { Kbd, KbdGroup } from "./ui/kbd.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.tsx"
import { Slider } from "./ui/slider.tsx"
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"
import {
  BoltIcon,
  BranchIcon,
  CheckIcon,
  type IconComponent,
  ShieldIcon,
  ShieldUserIcon,
  UnlockIcon,
} from "@hinacode/icons"

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

function useAgentModels(environment: EnvironmentId, provider: ProviderId, keep: string | null) {
  const listed = AsyncResult.getOrElse(
    useAtomValue(modelsAtom(environment, provider)),
    (): ReadonlyArray<ModelInfo> => [],
  )
  return keep === null || listed.some((model) => model.id === keep)
    ? listed
    : [unlistedModel(keep, provider), ...listed]
}

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
  none: m.effort_none,
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

const effortHints: Record<string, () => string> = {
  ultrathink: m.effort_ultrathink_hint,
  ultracode: m.effort_ultracode_hint,
}

const DEFAULT_EFFORT = "default"

const effortShare = (model: ModelInfo | undefined, effort: string | null) => {
  if (model === undefined || effort === null) return 0
  return (model.efforts.indexOf(effort) + 1) / model.efforts.length
}

export const accessModes: Record<AccessMode, { readonly icon: IconComponent; readonly label: () => string }> = {
  supervised: { icon: ShieldUserIcon, label: m.access_supervised },
  auto: { icon: ShieldIcon, label: m.access_auto },
  full: { icon: UnlockIcon, label: m.access_full },
}

const behaviorCopy: Record<AccessBehavior, { readonly label: () => string; readonly hint: () => string }> = {
  askEditsAndCommands: { label: m.access_supervised, hint: m.access_hint_askEditsAndCommands },
  askUnlessReadOnly: { label: m.access_supervised, hint: m.access_hint_askUnlessReadOnly },
  askProtectedWrites: { label: m.access_supervised_muse, hint: m.access_hint_askProtectedWrites },
  askEveryTool: { label: m.access_supervised, hint: m.access_hint_askEveryTool },
  autoApprovesSafeActions: { label: m.access_auto, hint: m.access_hint_autoApprovesSafeActions },
  acceptEdits: { label: m.access_accept_edits, hint: m.access_hint_acceptEdits },
  sandboxed: { label: m.access_auto, hint: m.access_hint_sandboxed },
  aiReview: { label: m.access_auto_muse, hint: m.access_hint_aiReview },
  bypass: { label: m.access_full, hint: m.access_hint_bypass },
  unrestricted: { label: m.access_full_muse, hint: m.access_hint_unrestricted },
}

const accessCopy = (thread: Thread, accessMode: AccessMode, model: ModelInfo | undefined) =>
  behaviorCopy[accessBehavior(thread.provider, accessMode, model)]

interface AgentTab {
  readonly value: string
  readonly provider: ProviderId
  readonly accountId?: string | null
  readonly label: string
  readonly hint?: string
  readonly disabled: boolean
}

export const pickerProviders = (own: ProviderId, setUp: ReadonlyArray<ProviderId>) =>
  ProviderId.literals.filter((provider) => provider === own || setUp.includes(provider))

function useAgentTabs(thread: Thread, canSwitchAgent: boolean): ReadonlyArray<AgentTab> {
  const environment = useThreadEnvironment(thread.id)
  const enabled = new Set(enabledProviders(useSettings(environment), useInstalledProviders(environment)))
  const setUpProviders = useAtomValue(setUpProvidersAtom(environment)).filter((provider) => enabled.has(provider))
  const accounts = useAccountOptions(thread).options
  const accountHint = useAccountHint()
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
  return pickerProviders(thread.provider, setUpProviders).flatMap((provider): ReadonlyArray<AgentTab> =>
    provider === thread.provider
      ? own
      : [{ value: provider, provider, label: providerLabel[provider](), disabled: !canSwitchAgent }],
  )
}

const modelMatches = (model: ModelInfo, query: string) => {
  const text = `${model.label} ${model.id}`.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word))
}

const nearest = { block: "nearest", inline: "nearest" } as const

const isThreadTab = (tab: AgentTab, thread: Thread) =>
  tab.provider === thread.provider && (tab.accountId === undefined || tab.accountId === thread.accountId)

const ALT = formatForDisplay("Alt")

function AltKey({ children, className }: { children: string; className?: string }) {
  const held = useAltHeld()
  return (
    <Kbd aria-hidden className={cn(className, !held && "invisible")}>
      {children}
    </Kbd>
  )
}

export function ThreadPicker({ thread, canSwitchAgent, onError }: ControlProps & { canSwitchAgent: boolean }) {
  const environment = useThreadEnvironment(thread.id)
  const current = useThreadModel(thread)
  const selected = current ?? unlistedModel(thread.model, thread.provider)
  const tabs = useAgentTabs(thread, canSwitchAgent)
  const threadTab = tabs.find((tab) => isThreadTab(tab, thread))?.value ?? thread.provider
  const [open, setOpen] = useState(false)
  const [tabValue, setTabValue] = useState(threadTab)
  const [focus, setFocus] = useState<ComposerPicker>("model")
  const [query, setQuery] = useState("")
  const [clearingHighlight, setClearingHighlight] = useState(false)
  const [picking, startPicking] = useTransition()
  const openedByShortcut = useRef(false)
  const tabMovedToByKey = useRef<string | null>(null)
  const closedWithEnter = useRef(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const tab = tabs.find((candidate) => candidate.value === tabValue) ?? tabs[0]!
  const models = usePickerModels(environment, tab.provider, tab.provider === thread.provider ? thread.model : null)
  const ownModels = usePickerModels(environment, thread.provider, null)
  const set = (patch: Omit<RpcRequest<"threads.update">, "id">) => void update({ ...patch, id: thread.id }, onError)
  const registry = use(RegistryContext)
  const tabProviders = [...new Set(tabs.map((candidate) => candidate.provider))]
  const refreshModels = () => {
    for (const provider of tabProviders) registry.refresh(modelsAtom(environment, provider))
  }

  const show = (picker: ComposerPicker) => {
    refreshModels()
    closedWithEnter.current = false
    setFocus(picker)
    setTabValue(threadTab)
    setQuery("")
    setOpen(true)
  }

  const showFromShortcut = useEffectEvent((picker: ComposerPicker) => {
    openedByShortcut.current = true
    show(picker)
  })

  const isSidechat = thread.sideOf !== null
  useEffect(
    () =>
      useUi.subscribe((state, previous) => {
        const request = state.pickerRequest
        if (request === previous.pickerRequest || request === null || request.inSidechat !== isSidechat) return
        showFromShortcut(request.picker)
      }),
    [isSidechat],
  )

  const pick = async (next: ModelInfo, target: AgentTab = tab) => {
    if (target.provider !== thread.provider) {
      await update({ id: thread.id, provider: next.provider, model: next.id }, onError)
      return
    }
    const latest = useThreads.getState().byId[thread.id] ?? thread
    if (target.accountId !== undefined && target.accountId !== latest.accountId) {
      try {
        await switchAccount(thread.id, target.accountId)
      } catch (cause) {
        onError(errorMessage(cause))
        return
      }
    }
    if (next.id === latest.model) return
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

  const accountSwitches = useRef(Promise.resolve())
  const openTab = (value: string) => {
    // FIXME: Base UI keeps an open inline combobox's highlight index when its items change and has no API to reset it. One commit with an empty list makes it drop the index without remounting the search box.
    flushSync(() => {
      setTabValue(value)
      setClearingHighlight(true)
    })
    flushSync(() => setClearingHighlight(false))
    const target = tabs.find((candidate) => candidate.value === value)
    const firstOwnModel = ownModels[0]
    if (target?.accountId === undefined || target.provider !== thread.provider || firstOwnModel === undefined) return
    if (target.accountId === (useThreads.getState().byId[thread.id] ?? thread).accountId) return
    startPicking(() => {
      accountSwitches.current = accountSwitches.current.then(() => pick(firstOwnModel, target))
      return accountSwitches.current
    })
  }

  const moveTab = (step: number) => {
    const enabled = tabs.filter((candidate) => !candidate.disabled)
    const next = enabled[(enabled.indexOf(tab) + step + enabled.length) % enabled.length]
    if (next === undefined) return
    tabMovedToByKey.current = next.value
    openTab(next.value)
  }
  useEffect(() => {
    if (tabMovedToByKey.current !== tab.value) return
    tabMovedToByKey.current = null
    popupRef.current?.querySelector("[role=tab][aria-selected=true]")?.scrollIntoView(nearest)
  })

  const efforts = current === undefined || current.efforts.length === 0 ? [] : [DEFAULT_EFFORT, ...current.efforts]
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
  const stepAccess = (step: number) => set({ accessMode: stepThrough(AccessMode.literals, thread.accessMode, step) })
  const altKeys: Record<string, ((step: number) => void) | null> = {
    KeyH: () => moveTab(-1),
    KeyL: () => moveTab(1),
    KeyE: stepEffort,
    KeyF: toggleFast,
    KeyM: stepAccess,
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      const action = altKeys[event.code]
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action(event.shiftKey ? -1 : 1)
      return
    }
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    closedWithEnter.current = true
    setOpen(false)
  }

  const effort = thread.effort ?? current?.defaultEffort ?? null
  const summary = [
    selected.label,
    effort === null ? null : effortLabel(effort),
    thread.fastMode ? m.thread_fast_mode() : null,
    thread.accessMode === "full" ? accessCopy(thread, "full", current).label() : null,
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
            className={cn("max-w-full min-w-0 shrink [&_svg]:-translate-y-px", triggerClass)}
          />
        }
      >
        <ProviderIcon provider={thread.provider} />
        <span className="min-w-0 truncate text-foreground">{selected.label}</span>
        {effort !== null && <span className="shrink-0">{effortLabel(effort)}</span>}
        {thread.fastMode && <BoltIcon aria-hidden className="shrink-0" />}
        {thread.accessMode === "full" && <AccessIcon aria-hidden className="shrink-0 text-destructive" />}
      </PopoverTrigger>
      <PopoverContent
        ref={popupRef}
        aria-label={m.thread_model_picker()}
        side="top"
        align="start"
        sideOffset={6}
        collisionAvoidance={{ side: "none", fallbackAxisSide: "none" }}
        className="h-[min(520px,var(--available-height))] w-90 max-w-[calc(100vw-1rem)] gap-3 p-2"
        initialFocus={() =>
          (focus === "effort"
            ? popupRef.current?.querySelector<HTMLElement>("[data-slot=slider-thumb] input")
            : searchRef.current) ??
          popupRef.current ??
          true
        }
        finalFocus={() => {
          if (!closedWithEnter.current) return openedByShortcut.current ? returnFocus() : true
          useUi.getState().requestComposerFocus()
          return false
        }}
        onKeyDown={onKeyDown}
      >
        <Tabs
          value={tab.value}
          changeAction={(value) => openTab(String(value))}
          className="-mx-2 gap-1 border-b border-border px-2 pb-2"
        >
          <div className="flex items-center gap-2">
            <TabsList className="-m-0.75 min-w-0 scrollbar-none justify-start overflow-x-auto bg-transparent p-0.75 motion-safe:scroll-smooth">
              {tabs.map((candidate) => (
                <Tooltip key={candidate.value}>
                  <TooltipTrigger
                    render={
                      <TabsTrigger value={candidate.value} disabled={candidate.disabled} className="flex-none px-2" />
                    }
                  >
                    <ProviderIcon provider={candidate.provider} />
                    <span className={candidate.accountId === undefined ? "sr-only" : "max-w-40 truncate"}>
                      {candidate.label}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{candidate.label}</TooltipContent>
                </Tooltip>
              ))}
            </TabsList>
            <KbdGroup aria-hidden className="ml-auto">
              <Kbd>{ALT}</Kbd>
              <Kbd>H</Kbd>
              <Kbd>L</Kbd>
            </KbdGroup>
          </div>
          {tab.hint && <p className="px-1 text-xs text-muted-foreground tabular-nums">{tab.hint}</p>}
        </Tabs>
        <Combobox.Root
          inline
          open
          filteredItems={clearingHighlight ? [] : undefined}
          autoHighlight
          items={models}
          filter={modelMatches}
          itemToStringLabel={(model: ModelInfo) => model.label}
          isItemEqualToValue={sameModel}
          value={isThreadTab(tab, thread) ? selected : null}
          onValueChange={(model) => {
            if (model !== null && !picking) startPicking(() => pick(model))
          }}
          inputValue={query}
          onInputValueChange={(next, details) => {
            if (details.reason !== "item-press") setQuery(next)
          }}
          disabled={tab.disabled}
        >
          <Combobox.Input
            ref={searchRef}
            aria-label={m.thread_model_search()}
            placeholder={m.thread_model_search()}
            spellCheck={false}
            onKeyDown={onKeyDown}
            render={<Input className="shrink-0" />}
          />
          <Combobox.List
            aria-label={m.thread_model_picker()}
            className="flex min-h-0 flex-1 scroll-fade-y scroll-py-1 scrollbar-gutter-stable flex-col gap-0.5 overflow-y-auto"
          >
            {(model: ModelInfo) => (
              <Combobox.Item
                key={model.id}
                value={model}
                aria-disabled={picking}
                className="group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none aria-disabled:opacity-50 aria-selected:font-medium data-highlighted:bg-accent data-disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{model.label}</span>
                <CheckIcon aria-hidden className="invisible size-4 shrink-0 group-aria-selected:visible" />
              </Combobox.Item>
            )}
          </Combobox.List>
          <Combobox.Empty className="px-2 py-1.5 text-sm text-muted-foreground empty:hidden">
            {models.length > 0 && m.thread_model_no_match()}
          </Combobox.Empty>
        </Combobox.Root>
        <div className="flex shrink-0 flex-col gap-3 border-t border-border px-1 pt-3">
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
                icon={BoltIcon}
                label={m.thread_fast_mode()}
                hint={m.thread_fast_mode_hint()}
                shortcut="F"
                on={thread.fastMode}
                toggle={toggleFast}
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
        <AltKey className="h-4 min-w-4">E</AltKey>
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
  readonly icon: IconComponent
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
            <AltKey className="-mr-1 h-4 min-w-4">{shortcut}</AltKey>
          </Button>
        }
      />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

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
              <span className="truncate">{accessCopy(thread, value, model).label()}</span>
            </Toggle>
          )
        })}
      </ToggleGroup>
      <div className="flex items-start gap-2 px-0.5">
        <p className="flex-1 text-xs text-pretty text-muted-foreground">
          {accessCopy(thread, thread.accessMode, model).hint()}
        </p>
        <AltKey>M</AltKey>
      </div>
    </div>
  )
}

type RefSuggestion =
  | { readonly kind: "pullRequest"; readonly ref: string; readonly pullRequest: OpenPullRequest }
  | { readonly kind: "branch"; readonly ref: string }

const SUGGESTIONS_PER_GROUP = 20

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
      className="flex h-7 cursor-default [scroll-margin-block:0.25rem] items-center gap-2 rounded-sm px-2 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
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
          <BranchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-mono">{suggestion.ref}</span>
        </>
      )}
    </Autocomplete.Item>
  )
}

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
        // FIXME: Base UI clears the field on Escape while the list is closed
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
          if (event.key === "Enter") event.preventDefault()
        }}
        render={
          <Input className="field-sizing-content h-6 max-w-96 min-w-16 rounded-sm border-0 px-1 font-mono text-xs text-foreground shadow-none focus-visible:ring-2 dark:bg-transparent" />
        }
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner side="top" align="start" sideOffset={6} collisionPadding={8} className="isolate z-50">
          <Autocomplete.Popup className="max-h-[min(20rem,var(--available-height))] w-96 max-w-(--available-width) origin-(--transform-origin) scrollbar-gutter-stable overflow-y-auto overscroll-contain rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-[opacity,scale] duration-150 ease-out data-ending-style:scale-97 data-ending-style:opacity-0 data-ending-style:duration-100 data-starting-style:scale-97 data-starting-style:opacity-0 motion-reduce:transition-none">
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

function ContextSwitch({
  thread,
  label,
  options,
  children,
}: {
  thread: Thread
  label: string
  options: ReadonlyArray<ContextOption>
  children?: ReactNode
}) {
  const navigate = useNavigate()
  const [isMoving, startMoving] = useTransition()
  if (options.length < 2 && !children) return <span className={contextWord}>{label}</span>
  const move = (projectId: string) =>
    startMoving(async () => {
      try {
        await moveDraft(thread, projectId, navigate)
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
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ThreadProjectSwitch({ thread }: { thread: Thread }) {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const current = projects.find((project) => project.id === thread.projectId)
  const options = projects
    .filter((project) => project.kind !== "chats" && environmentOf(project) === environmentOf(current))
    .map((project) => ({ projectId: project.id, label: project.name }))
  return <ContextSwitch thread={thread} label={current?.name ?? ""} options={options} />
}

export function ThreadEnvironmentSwitch({ thread }: { thread: Thread }) {
  const navigate = useNavigate()
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), (): ReadonlyArray<Project> => [])
  const clouds = useClouds()
  const [creatingOn, setCreatingOn] = useState<EnvironmentId | undefined>(undefined)
  const current = projects.find((project) => project.id === thread.projectId)
  const environment = environmentOf(current)
  const members =
    groupProjects(projects).find((group) => group.projects.some((project) => project.id === thread.projectId))
      ?.projects ?? []
  const options = members.map((project) => ({
    projectId: project.id,
    label: environmentName(environmentOf(project), clouds),
  }))
  const cloneSource = clonableRepository(current)
  const reachable: ReadonlyArray<EnvironmentId> = [
    ...(inBrowser() ? [] : [null]),
    ...clouds.filter((cloud) => cloud.status === "connected").map((cloud) => cloud.id),
  ]
  const missing =
    cloneSource === null
      ? []
      : reachable.filter((candidate) => members.every((project) => environmentOf(project) !== candidate))
  const inlineName = (id: EnvironmentId) =>
    id === null ? m.environment_this_machine_inline() : environmentName(id, clouds)
  return (
    <>
      <ContextSwitch thread={thread} label={inlineName(environment)} options={options}>
        {missing.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {missing.map((candidate) => (
              <DropdownMenuItem
                key={candidate ?? "local"}
                onClick={() => startTransition(() => setCreatingOn(candidate))}
              >
                {m.thread_environment_create({ machine: inlineName(candidate) })}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </ContextSwitch>
      {creatingOn !== undefined && cloneSource !== null && (
        <ProjectDialog
          open
          onOpenChange={(open) => !open && setCreatingOn(undefined)}
          environment={creatingOn}
          source={cloneSource}
          onCreated={(created) =>
            moveDraft(thread, created.id, navigate).catch((cause: unknown) => toast.error(errorMessage(cause)))
          }
        />
      )}
    </>
  )
}

function clonableRepository(project: Project | undefined) {
  const [owner, name, ...folder] = project?.repository?.split("/") ?? []
  if (project === undefined || owner === undefined || name === undefined || folder.length > 0) return null
  return { rootPath: `https://github.com/${owner}/${name}`, name: project.name }
}

export function WorkspacePicker({ thread, workspace }: { thread: Thread; workspace: Draft["workspace"] }) {
  const currentBranch = AsyncResult.getOrElse(useAtomValue(currentBranchAtom(thread.projectId)), () => "")
  const defaultBranch = AsyncResult.getOrElse(useAtomValue(defaultBranchAtom(thread.projectId)), () => "main")
  const setWorkspace = (next: Draft["workspace"]) => useDrafts.getState().setWorkspace(thread.id, next)
  const mode = workspace?.mode ?? "local"
  const ref = workspace?.ref ?? currentBranch
  const RefIcon = parsePullRequestSelector(ref) ? RiGitPullRequestLine : BranchIcon

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
