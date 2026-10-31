import { useAtomValue } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import type { ReactNode } from "react"
import { RiGithubFill, RiSlackFill } from "react-icons/ri"
import type { AgentAccount, ProviderId } from "../../../shared/agent.ts"
import type { EnvironmentStatus, GitHubAuth } from "../../../shared/domain.ts"
import { type Cloud, statusLabel, useCloudStateText, useClouds } from "../../lib/environments.ts"
import { accountAtom, type EnvironmentId, gitHubAuthAtom, secretStoredAtom } from "../../lib/rpc.ts"
import { cn } from "../../lib/utils.ts"
import { m } from "../../paraglide/messages.js"
import { LinearIcon } from "../icons/LinearIcon.tsx"
import { ProviderIcon, providerLabel } from "../ProviderIcon.tsx"
import { Button } from "../ui/button.tsx"
import { Skeleton } from "../ui/skeleton.tsx"
import { SettingsSection, settingsSurfaceClass } from "./SettingsSection.tsx"
import { CheckIcon } from "../icons/CheckIcon.tsx"
import { CloudIcon } from "../icons/CloudIcon.tsx"
import { LaptopIcon } from "../icons/LaptopIcon.tsx"
import { MinusIcon } from "../icons/MinusIcon.tsx"
import { WarningFillIcon } from "../icons/WarningFillIcon.tsx"

type Tone = "ready" | "attention" | "off" | "loading"

interface Check {
  readonly tone: Tone
  readonly text: string
}

interface Machine {
  readonly id: EnvironmentId
  readonly name: string
  readonly cloud: Cloud | null
}

const reachable = (machine: Machine) => machine.cloud === null || machine.cloud.status === "connected"

interface CellProps {
  readonly item: string
  readonly machine: Machine
  readonly onOpen: () => void
}

interface Row {
  readonly id: string
  readonly label: () => string
  readonly icon: ReactNode
  readonly page: string
  readonly cell: (props: CellProps) => ReactNode
}

const loading: Check = { tone: "loading", text: "" }
const unavailable: Check = { tone: "attention", text: m.settings_setup_unavailable() }

const agentCheck = (account: AgentAccount): Check => {
  switch (account.type) {
    case "subscription":
      return { tone: "ready", text: account.plan ?? account.email ?? m.settings_account_api_key() }
    case "apiKey":
      return { tone: "ready", text: m.settings_account_api_key() }
    case "external":
      return { tone: "ready", text: account.service }
    case "signedOut":
      return { tone: "off", text: m.settings_account_signed_out() }
  }
}

const gitHubCheck = (auth: GitHubAuth): Check => {
  switch (auth.type) {
    case "signedIn":
      return { tone: "ready", text: auth.login }
    case "missing":
      return { tone: "attention", text: m.settings_setup_gh_missing() }
    case "signedOut":
      return { tone: "attention", text: m.settings_setup_gh_signed_out() }
  }
}

const secretCheck = (stored: boolean): Check =>
  stored ? { tone: "ready", text: m.settings_setup_ready_key() } : { tone: "off", text: m.settings_setup_not_set() }

function AgentCell({ provider, ...props }: CellProps & { provider: ProviderId }) {
  const account = useAtomValue(accountAtom(props.machine.id, provider, null))
  return (
    <SetupButton
      {...props}
      check={AsyncResult.builder(account)
        .onSuccess(agentCheck)
        .onError(() => unavailable)
        .orElse(() => loading)}
    />
  )
}

function GitHubCell(props: CellProps) {
  const auth = useAtomValue(gitHubAuthAtom(props.machine.id))
  return (
    <SetupButton
      {...props}
      check={AsyncResult.builder(auth)
        .onSuccess(gitHubCheck)
        .onError(() => unavailable)
        .orElse(() => loading)}
    />
  )
}

function SecretCell({ name, ...props }: CellProps & { name: string }) {
  const stored = useAtomValue(secretStoredAtom(props.machine.id, name))
  return (
    <SetupButton
      {...props}
      check={AsyncResult.builder(stored)
        .onSuccess(secretCheck)
        .onError(() => unavailable)
        .orElse(() => loading)}
    />
  )
}

const rows: ReadonlyArray<Row> = [
  ...(["claude", "codex", "muse"] as const).map((provider): Row => ({
    id: provider,
    label: providerLabel[provider],
    icon: <ProviderIcon provider={provider} className="size-4" />,
    page: "providers",
    cell: (props) => <AgentCell provider={provider} {...props} />,
  })),
  {
    id: "github",
    label: m.settings_github_label,
    icon: <RiGithubFill aria-hidden className="size-4 shrink-0" />,
    page: "integrations",
    cell: (props) => <GitHubCell {...props} />,
  },
  {
    id: "linear",
    label: () => "Linear",
    icon: <LinearIcon className="size-4 shrink-0" />,
    page: "integrations",
    cell: (props) => <SecretCell name="linear.apiKey" {...props} />,
  },
  {
    id: "slack",
    label: () => "Slack",
    icon: <RiSlackFill aria-hidden className="size-4 shrink-0" />,
    page: "integrations",
    cell: (props) => <SecretCell name="slack.token" {...props} />,
  },
]

const toneIcon: Record<Tone, ReactNode> = {
  ready: <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  attention: <WarningFillIcon aria-hidden className="size-3.5 shrink-0 text-attention" />,
  off: <MinusIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  loading: null,
}

const linkTone: Record<EnvironmentStatus, string> = {
  connecting: "text-muted-foreground",
  connected: "text-muted-foreground",
  offline: "text-destructive",
  unauthorized: "text-attention",
  incompatible: "text-attention",
}

function SetupButton({ item, machine, onOpen, check }: CellProps & { check: Check }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={m.settings_setup_cell({
        item,
        machine: machine.name,
        state: check.tone === "loading" ? m.settings_account_loading() : check.text,
      })}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left pressable outline-none hover:bg-foreground/6 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {check.tone === "loading" ? (
        <Skeleton className="h-3.5 w-24 bg-foreground/10" />
      ) : (
        <>
          {toneIcon[check.tone]}
          <span className={cn("truncate", check.tone === "off" && "text-muted-foreground")}>{check.text}</span>
        </>
      )}
    </button>
  )
}

function UnreachableCell({ cloud, span, onOpen }: { cloud: Cloud; span: number; onOpen: () => void }) {
  const state = useCloudStateText(cloud)
  const reason = cloud.status === "unauthorized" ? m.environment_unauthorized_hint() : state
  return (
    <td rowSpan={span} aria-label={reason ?? undefined} className="p-2.5 align-top">
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-pretty">{reason}</p>
        <Button variant="outline" size="sm" onClick={onOpen}>
          {cloud.status === "unauthorized" ? m.environment_pair_again() : m.settings_connections()}
        </Button>
      </div>
    </td>
  )
}

export function MachineSetup() {
  const clouds = useClouds()
  const machines: ReadonlyArray<Machine> = [
    { id: null, name: m.environment_this_machine(), cloud: null },
    ...clouds.map((cloud) => ({ id: cloud.id, name: cloud.name, cloud })),
  ]
  const navigate = useNavigate()
  const open = (page: string, environment: EnvironmentId) =>
    void navigate({ to: "/settings", search: { page, ...(environment === null ? {} : { environment }) } })

  return (
    <SettingsSection title={m.settings_setup_title()}>
      <div className={cn(settingsSurfaceClass, "overflow-x-auto p-1.5")}>
        <table
          className="w-full table-fixed border-collapse text-sm"
          style={{ minWidth: `${8 + machines.length * 9}rem` }}
        >
          <colgroup>
            <col className="w-36" />
          </colgroup>
          <thead>
            <tr>
              <td aria-hidden />
              {machines.map((machine) => (
                <th key={machine.id ?? ""} scope="col" className="px-2.5 pt-2 pb-2.5 text-left align-top font-medium">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {machine.id === null ? (
                      <LaptopIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <CloudIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{machine.name}</span>
                  </span>
                  {machine.cloud !== null && machine.cloud.status !== "connected" && (
                    <span
                      className={cn(
                        "mt-0.5 flex items-center gap-1 text-xs font-normal",
                        linkTone[machine.cloud.status],
                      )}
                    >
                      <WarningFillIcon aria-hidden className="size-3.5 shrink-0" />
                      {statusLabel[machine.cloud.status]()}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-foreground/8">
                <th scope="row" className="px-2.5 py-1 text-left font-normal">
                  <span className="flex items-center gap-2">
                    {row.icon}
                    {row.label()}
                  </span>
                </th>
                {machines.map((machine) =>
                  reachable(machine) ? (
                    <td key={machine.id ?? ""} className="p-0.5">
                      {row.cell({ item: row.label(), machine, onOpen: () => open(row.page, machine.id) })}
                    </td>
                  ) : (
                    row === rows[0] &&
                    machine.cloud !== null && (
                      <UnreachableCell
                        key={machine.id ?? ""}
                        cloud={machine.cloud}
                        span={rows.length}
                        onOpen={() => open("connections", null)}
                      />
                    )
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  )
}
