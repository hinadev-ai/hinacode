import type { InstalledAgent, ProviderId } from "../../shared/agent.ts"
import { providerCli } from "../../shared/providers.ts"
import { m } from "../paraglide/messages.js"
import { CheckIcon } from "./icons/CheckIcon.tsx"
import { ExternalIcon } from "./icons/ExternalIcon.tsx"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { Field, FieldContent, FieldDescription, FieldLabel } from "./ui/field.tsx"
import { Switch } from "./ui/switch.tsx"

export interface AgentChoicesProps {
  readonly providers: ReadonlyArray<ProviderId>
  readonly installed: ReadonlyArray<InstalledAgent> | null
  readonly enabled: ReadonlyArray<ProviderId>
  readonly locked?: ProviderId
  readonly onChange: (provider: ProviderId, enabled: boolean) => void
}

export function AgentChoices({ providers, installed, enabled, locked, onChange }: AgentChoicesProps) {
  return providers.map((provider) => (
    <Field key={provider} orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={`agent-enabled-${provider}`} className="gap-2">
          <ProviderIcon provider={provider} className="size-4" />
          {providerLabel[provider]()}
        </FieldLabel>
        <FieldDescription>
          <AgentStatus
            provider={provider}
            installed={installed?.find((agent) => agent.provider === provider)?.installed ?? null}
          />
        </FieldDescription>
      </FieldContent>
      <Switch
        id={`agent-enabled-${provider}`}
        checked={enabled.includes(provider)}
        disabled={provider === locked}
        title={provider === locked ? m.settings_agents_last() : undefined}
        onCheckedChange={(checked) => onChange(provider, checked)}
      />
    </Field>
  ))
}

function AgentStatus({ provider, installed }: { provider: ProviderId; installed: boolean | null }) {
  if (installed === null) return m.onboarding_checking()
  if (installed) {
    return (
      <span className="inline-flex items-center gap-1">
        <CheckIcon aria-hidden className="size-3.5 text-success" />
        {m.onboarding_installed()}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      {m.onboarding_not_installed()}
      <a
        href={providerCli[provider].installUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={m.onboarding_install({ agent: providerLabel[provider]() })}
        className="inline-flex items-center text-foreground underline underline-offset-2"
      >
        {m.onboarding_install_short()}
        <ExternalIcon aria-hidden className="size-3.5" />
      </a>
    </span>
  )
}
