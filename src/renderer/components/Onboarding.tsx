import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { useState } from "react"
import { RiRefreshLine } from "react-icons/ri"
import { type InstalledAgent, ProviderId } from "../../shared/agent.ts"
import { newThreadProvider } from "../../shared/providers.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { installedAgentsAtom, updateSettingsAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { m } from "../paraglide/messages.js"
import { AgentChoices } from "./AgentChoices.tsx"
import { settingsGroupClass } from "./settings/SettingsSection.tsx"
import { Button } from "./ui/button.tsx"

const entering = "animate-enter motion-reduce:animate-fade-in"

export function Onboarding() {
  const detected = useAtomValue(installedAgentsAtom(null))
  const refresh = useAtomRefresh(installedAgentsAtom(null))
  const installed = AsyncResult.isSuccess(detected) ? detected.value : null
  const found = installed?.filter((agent) => agent.installed).map((agent) => agent.provider) ?? []
  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="window-drag h-titlebar shrink-0" />
      <main className="m-auto flex w-full max-w-md flex-col gap-6 px-6 pb-titlebar">
        <header className={cn("flex flex-col gap-2", entering)}>
          <p className="text-sm text-muted-foreground">{m.app_name()}</p>
          <h1 id="onboarding-title" className="font-heading text-2xl font-semibold">
            {m.onboarding_title()}
          </h1>
          <p className="text-sm text-pretty text-muted-foreground">{m.onboarding_description()}</p>
        </header>
        <AgentPicker
          key={installed === null ? "checking" : found.join()}
          installed={installed}
          found={found}
          checking={detected.waiting}
          onCheckAgain={refresh}
        />
      </main>
    </div>
  )
}

interface AgentPickerProps {
  readonly installed: ReadonlyArray<InstalledAgent> | null
  readonly found: ReadonlyArray<ProviderId>
  readonly checking: boolean
  readonly onCheckAgain: () => void
}

function AgentPicker({ installed, found, checking, onCheckAgain }: AgentPickerProps) {
  const settings = useSettings(null)
  const updateSettings = useAtomSet(updateSettingsAtom(null), { mode: "promise" })
  const [enabled, setEnabled] = useState<ReadonlyArray<ProviderId>>(found)
  const [error, setError] = useState<string | null>(null)
  const noneFound = installed !== null && found.length === 0

  const toggle = (provider: ProviderId, on: boolean) =>
    setEnabled((current) => ProviderId.literals.filter((id) => (id === provider ? on : current.includes(id))))

  const start = async () => {
    setError(null)
    try {
      await updateSettings({
        enabledProviders: enabled,
        defaultProvider: newThreadProvider({ defaultProvider: settings.defaultProvider, enabledProviders: enabled }),
      })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <>
      <fieldset
        aria-labelledby="onboarding-title"
        className={cn(settingsGroupClass, entering, "min-w-0 [animation-delay:100ms]")}
      >
        <AgentChoices providers={ProviderId.literals} installed={installed} enabled={enabled} onChange={toggle} />
      </fieldset>
      {noneFound && <p className="text-sm text-pretty text-muted-foreground">{m.onboarding_none_found()}</p>}
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <footer className={cn("flex items-center justify-between gap-2", entering, "[animation-delay:200ms]")}>
        <Button variant="ghost" disabled={checking} onClick={onCheckAgain}>
          <RiRefreshLine aria-hidden />
          {m.onboarding_check_again()}
        </Button>
        <Button size="lg" disabled={enabled.length === 0} action={start}>
          {m.onboarding_start()}
        </Button>
      </footer>
    </>
  )
}
