import { useAtomSet } from "@effect/atom-react"
import { useState } from "react"
import type { AgentsMd } from "../../../shared/domain.ts"
import { useSettingsEnvironment } from "../../lib/environments.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { updateSettingsAtom } from "../../lib/rpc.ts"
import { useSettings } from "../../lib/settings.ts"
import { m } from "../../paraglide/messages.js"
import { ProviderIcon, providerLabel } from "../ProviderIcon.tsx"
import { Field, FieldDescription, FieldError, FieldLabel } from "../ui/field.tsx"
import { Textarea } from "../ui/textarea.tsx"
import { SettingsGroup, SettingsSection } from "./SettingsSection.tsx"

const agents = ["claude", "codex", "muse"] as const

export function InstructionsSettings() {
  const environment = useSettingsEnvironment()
  const { agentsMd } = useSettings(environment)
  const updateSettings = useAtomSet(updateSettingsAtom(environment), { mode: "promise" })
  const [error, setError] = useState<string | null>(null)

  const save = async (scope: keyof AgentsMd, text: string) => {
    if (text === agentsMd[scope]) return
    setError(null)
    try {
      await updateSettings({ agentsMd: { ...agentsMd, [scope]: text } })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <SettingsSection title={m.settings_instructions()} description={m.settings_instructions_hint()}>
      <SettingsGroup>
        <Field>
          <FieldLabel htmlFor="settings-instructions-all">{m.settings_instructions_all()}</FieldLabel>
          <Textarea
            // Keyed by the stored value, so a save from elsewhere replaces what the field shows.
            key={agentsMd.all}
            id="settings-instructions-all"
            defaultValue={agentsMd.all}
            onBlur={(event) => void save("all", event.currentTarget.value)}
            placeholder={m.settings_instructions_all_placeholder()}
            spellCheck={false}
            className="min-h-48 font-mono text-xs md:text-xs"
          />
          <FieldDescription>{m.settings_instructions_footer()}</FieldDescription>
        </Field>
        {agents.map((agent) => (
          <Field key={agent}>
            <FieldLabel htmlFor={`settings-instructions-${agent}`}>
              <ProviderIcon provider={agent} />
              {providerLabel[agent]()}
            </FieldLabel>
            <Textarea
              key={agentsMd[agent]}
              id={`settings-instructions-${agent}`}
              defaultValue={agentsMd[agent]}
              onBlur={(event) => void save(agent, event.currentTarget.value)}
              placeholder={m.settings_instructions_agent_placeholder()}
              spellCheck={false}
              className="font-mono text-xs md:text-xs"
            />
          </Field>
        ))}
        {error && <FieldError>{error}</FieldError>}
      </SettingsGroup>
    </SettingsSection>
  )
}
