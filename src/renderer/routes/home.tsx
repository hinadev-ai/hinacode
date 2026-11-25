import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult, Atom } from "effect/reactivity"
import { type ReactNode, useEffect, useId } from "react"
import type { AgentAccount, ProviderId } from "../../shared/agent.ts"
import { enabledProviders } from "../../shared/domain.ts"
import { ChordKeys } from "../components/ChordKeys.tsx"
import { MachineApprovalNotices } from "../components/CloudNotice.tsx"
import { ProviderIcon, providerLabel, providerSignInHint } from "../components/ProviderIcon.tsx"
import { Button } from "../components/ui/button.tsx"
import { Skeleton } from "../components/ui/skeleton.tsx"
import { commands } from "../keybindings/commands.ts"
import { useKeymap } from "../keybindings/useKeybindings.ts"
import { accountAtom, binariesAtom, familyOf, projectsAtom, refreshAccountAtom } from "../lib/rpc.ts"
import { inBrowser } from "../lib/runtime.ts"
import { useInstalledProviders, useSettings } from "../lib/settings.ts"
import { cn } from "../lib/utils.ts"
import { m } from "../paraglide/messages.js"
import { NEW_THREAD_PREFIX, usePalette } from "../palette/usePalette.ts"
import { useThreads } from "../stores/threads.ts"
import { useUi } from "../stores/ui.ts"
import { CheckIcon, FolderAddIcon, MinusIcon, PlusIcon, SettingsIcon, WarningFillIcon } from "@hinacode/icons"

type SignedInAccount = Exclude<AgentAccount, { readonly type: "signedOut" }>

type AgentReadiness =
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly account: SignedInAccount }
  | { readonly type: "signedOut" }
  | { readonly type: "unavailable" }

interface AgentRow {
  readonly provider: ProviderId
  readonly readiness: AgentReadiness
}

type Step = "agent" | "project" | "thread"

const readinessOf = (account: AgentAccount): AgentReadiness =>
  account.type === "signedOut" ? { type: "signedOut" } : { type: "ready", account }

const agentRowsAtom = familyOf((providers: ReadonlyArray<ProviderId>) =>
  Atom.make((get): ReadonlyArray<AgentRow> =>
    providers.map((provider) => ({
      provider,
      readiness: AsyncResult.builder(get(accountAtom(null, provider, null)))
        .onSuccess(readinessOf)
        .onError((): AgentReadiness => ({ type: "unavailable" }))
        .orElse((): AgentReadiness => ({ type: "loading" })),
    })),
  ),
)

type RefreshAccount = (input: {
  readonly environment: null
  readonly provider: ProviderId
  readonly accountId: null
}) => Promise<unknown>

const recheckOneAtATime = async (refreshAccount: RefreshAccount, providers: ReadonlyArray<ProviderId>) => {
  for (const provider of providers) {
    await refreshAccount({ environment: null, provider, accountId: null }).catch(() => undefined)
  }
}

const nextStep = (agentReady: boolean, hasProject: boolean): Step =>
  !agentReady ? "agent" : !hasProject ? "project" : "thread"

const commandTitle = (id: "thread.new" | "project.add") => commands.find((command) => command.id === id)?.title() ?? ""

const openAddProject = () => useUi.getState().setAddProjectOpen(true)
const openNewThread = () => usePalette.getState().show(NEW_THREAD_PREFIX)

export function HomeRoute() {
  const projects = AsyncResult.getOrElse(useAtomValue(projectsAtom), () => [])
  const keymap = useKeymap()
  const firstRun = useThreads((state) => Object.keys(state.byId).length === 0) && !inBrowser()
  const hasProjects = projects.length > 0

  const addProjectLabel = (
    <>
      <FolderAddIcon aria-hidden />
      {commandTitle("project.add")}
      {keymap["project.add"] && <ChordKeys chord={keymap["project.add"]} />}
    </>
  )
  const newThreadLabel = (
    <>
      <PlusIcon aria-hidden />
      {commandTitle("thread.new")}
      {keymap["thread.new"] && <ChordKeys chord={keymap["thread.new"]} />}
    </>
  )

  return (
    <div className="m-auto flex w-full max-w-lg flex-col items-center gap-6 px-6 py-8 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="font-heading text-2xl font-semibold">{m.app_name()}</h1>
        <p className="text-sm text-balance text-muted-foreground">{m.home_description()}</p>
      </div>
      <MachineApprovalNotices className="flex w-full flex-col text-left" />
      {firstRun ? (
        <GetStarted
          hasProject={projects.some((project) => project.kind === "folder")}
          addProjectLabel={addProjectLabel}
          newThreadLabel={newThreadLabel}
        />
      ) : (
        <div className="flex flex-wrap justify-center gap-2">
          {hasProjects && (
            <Button size="lg" onClick={openNewThread}>
              {newThreadLabel}
            </Button>
          )}
          <Button size="lg" variant={hasProjects ? "outline" : "default"} onClick={openAddProject}>
            {addProjectLabel}
          </Button>
        </div>
      )}
    </div>
  )
}

function GetStarted({
  hasProject,
  addProjectLabel,
  newThreadLabel,
}: {
  hasProject: boolean
  addProjectLabel: ReactNode
  newThreadLabel: ReactNode
}) {
  const titleId = useId()
  const settings = useSettings(null)
  const installed = useInstalledProviders(null)
  const agents = useAtomValue(agentRowsAtom(installed === undefined ? [] : enabledProviders(settings, installed)))
  const agentReady = agents.some((agent) => agent.readiness.type === "ready")
  const next = nextStep(agentReady, hasProject)
  const variantFor = (step: Step) => (step === next ? "default" : "outline")

  return (
    <section aria-labelledby={titleId} className="flex w-full flex-col gap-3 text-left">
      <h2 id={titleId} className="px-1 text-sm font-medium text-muted-foreground">
        {m.home_setup_title()}
      </h2>
      <ol className="flex flex-col rounded-xl bg-muted px-4 *:py-4 dark:bg-muted/50 [&>*+*]:border-t [&>*+*]:border-foreground/8">
        <SetupStep index={1} done={agentReady} title={m.home_setup_agent()} description={m.home_setup_agent_hint()}>
          <AgentChecklist agents={installed === undefined ? null : agents} />
        </SetupStep>
        <SetupStep
          index={2}
          done={hasProject}
          title={m.home_setup_project()}
          description={m.home_setup_project_hint()}
          action={
            <Button variant={variantFor("project")} onClick={openAddProject}>
              {addProjectLabel}
            </Button>
          }
        />
        <SetupStep
          index={3}
          done={false}
          title={m.home_setup_thread()}
          description={m.home_setup_thread_hint()}
          action={
            <Button variant={variantFor("thread")} onClick={openNewThread}>
              {newThreadLabel}
            </Button>
          }
        />
      </ol>
    </section>
  )
}

function SetupStep({
  index,
  done,
  title,
  description,
  action,
  children,
}: {
  index: number
  done: boolean
  title: string
  description: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border border-foreground/15 text-xs font-medium tabular-nums",
          done && "border-success/40 text-success",
        )}
      >
        {done ? <CheckIcon className="size-3.5" /> : index}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
        <div className="flex flex-col gap-0.5">
          <h3 className={cn("text-sm font-medium", done && "text-muted-foreground")}>
            {title}
            {done && <span className="sr-only">{` (${m.home_setup_done()})`}</span>}
          </h3>
          <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        </div>
        {action}
        {children}
      </div>
    </li>
  )
}

function AgentChecklist({ agents }: { agents: ReadonlyArray<AgentRow> | null }) {
  const navigate = useNavigate()
  const refreshAccount = useAtomSet(refreshAccountAtom, { mode: "promise" })
  const refreshBinaries = useAtomRefresh(binariesAtom(null))
  const waiting = (agents ?? [])
    .filter((agent) => agent.readiness.type === "signedOut" || agent.readiness.type === "unavailable")
    .map((agent) => agent.provider)
  const waitingKey = waiting.join(",")

  const recheck = () => {
    refreshBinaries()
    return recheckOneAtATime(refreshAccount, waiting)
  }

  useEffect(() => {
    if (waitingKey === "") return
    const recheckSignedOut = () => void recheckOneAtATime(refreshAccount, waitingKey.split(",") as Array<ProviderId>)
    window.addEventListener("focus", recheckSignedOut)
    return () => window.removeEventListener("focus", recheckSignedOut)
  }, [waitingKey, refreshAccount])

  return (
    <div className="flex w-full flex-col gap-2">
      {agents === null ? (
        <Skeleton className="h-4 w-48 bg-foreground/10" />
      ) : agents.length === 0 ? (
        <p className="text-sm text-pretty text-attention">{m.home_setup_agent_none()}</p>
      ) : (
        <ul aria-label={m.home_setup_agents()} className="flex flex-col gap-1.5">
          {agents.map((agent) => (
            <AgentStatus key={agent.provider} {...agent} />
          ))}
        </ul>
      )}
      <div className="-ms-2 flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" action={recheck}>
          {m.settings_account_check_again()}
        </Button>
        <Button variant="ghost" size="sm" action={() => navigate({ to: "/settings", search: { page: "providers" } })}>
          <SettingsIcon aria-hidden />
          {m.home_setup_agent_settings()}
        </Button>
      </div>
    </div>
  )
}

function AgentStatus({ provider, readiness }: AgentRow) {
  return (
    <li className="flex min-w-0 items-start gap-2 text-sm">
      <ProviderIcon provider={provider} className="mt-0.5 size-4" />
      <span className="w-24 shrink-0 truncate font-medium">{providerLabel[provider]()}</span>
      <span className="flex min-w-0 flex-1 items-start gap-1.5">
        <ReadinessText provider={provider} readiness={readiness} />
      </span>
    </li>
  )
}

function ReadinessText({ provider, readiness }: AgentRow) {
  switch (readiness.type) {
    case "loading":
      return <Skeleton className="mt-1 h-3.5 w-28 bg-foreground/10" />
    case "ready":
      return (
        <>
          <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
          <span className="truncate">{signedInLabel(provider, readiness.account)}</span>
        </>
      )
    case "signedOut":
      return (
        <>
          <MinusIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-pretty text-muted-foreground">{providerSignInHint[provider]()}</span>
        </>
      )
    case "unavailable":
      return (
        <>
          <WarningFillIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-attention" />
          <span className="text-attention">{m.settings_setup_unavailable()}</span>
        </>
      )
  }
}

const signedInLabel = (provider: ProviderId, account: SignedInAccount) => {
  switch (account.type) {
    case "subscription":
      return account.plan ?? m.home_setup_signed_in()
    case "apiKey":
      return m.settings_account_api_key()
    case "external":
      return account.service === providerLabel[provider]() ? m.home_setup_signed_in() : account.service
  }
}
