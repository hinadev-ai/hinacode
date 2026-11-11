import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import { AccessMode, type Thread } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import { OptionRow, Section } from "@/components/sheet"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { updateThread } from "@/stores/threads"

export const accessModes: Record<AccessMode, { label: string; icon: IconName }> = {
  supervised: { label: copy("mobile_settings_access_supervised"), icon: "ShieldUser" },
  auto: { label: copy("mobile_settings_access_auto"), icon: "Shield" },
  full: { label: copy("mobile_settings_access_full"), icon: "Unlock" },
}

const supervisedHints: Record<ProviderId, string> = {
  claude: copy("mobile_settings_access_supervised_hint"),
  codex: copy("mobile_composer_access_supervised_codex"),
  muse: copy("mobile_composer_access_supervised_muse"),
  opencode: copy("mobile_composer_access_supervised_opencode"),
  magpie: copy("mobile_settings_access_supervised_hint"),
}

const autoHints: Record<ProviderId, (model: ModelInfo | undefined) => string> = {
  claude: (model) =>
    model?.autoMode ? copy("mobile_composer_access_auto_claude") : copy("mobile_composer_access_auto_claude_edits"),
  codex: () => copy("mobile_composer_access_auto_codex"),
  muse: () => copy("mobile_composer_access_auto_muse"),
  opencode: () => copy("mobile_composer_access_auto_opencode"),
  magpie: () => copy("mobile_composer_access_auto_claude_edits"),
}

const accessHint = (accessMode: AccessMode, thread: Thread, model: ModelInfo | undefined) => {
  switch (accessMode) {
    case "supervised":
      return supervisedHints[thread.provider]
    case "auto":
      return autoHints[thread.provider](model)
    case "full":
      return copy("mobile_settings_access_full_hint")
  }
}

export function AccessModeSection({
  thread,
  model,
  onError,
}: {
  thread: Thread
  model: ModelInfo | undefined
  onError: (message: string) => void
}) {
  const theme = useTheme()
  return (
    <Section title={copy("mobile_composer_access")}>
      {AccessMode.literals.map((option) => (
        <OptionRow
          key={option}
          label={accessModes[option].label}
          icon={accessModes[option].icon}
          hint={accessHint(option, thread, model)}
          color={option === "full" ? theme.danger : undefined}
          selected={option === thread.accessMode}
          onPress={() => option !== thread.accessMode && void updateThread({ id: thread.id, accessMode: option }, onError)}
        />
      ))}
    </Section>
  )
}
