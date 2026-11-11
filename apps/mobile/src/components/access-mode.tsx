import { type AccessBehavior, accessBehavior } from "@shared/access.ts"
import type { ModelInfo } from "@shared/agent.ts"
import { AccessMode, type Thread } from "@shared/domain.ts"
import type { IconName } from "@/components/icon"
import { OptionRow, Section } from "@/components/sheet"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { updateThread } from "@/stores/threads"

export const accessModes: Record<AccessMode, { icon: IconName }> = {
  supervised: { icon: "ShieldUser" },
  auto: { icon: "Shield" },
  full: { icon: "Unlock" },
}

const behaviorCopy: Record<AccessBehavior, { label: string; hint: string }> = {
  askEditsAndCommands: { label: copy("access_supervised"), hint: copy("access_hint_askEditsAndCommands") },
  askUnlessReadOnly: { label: copy("access_supervised"), hint: copy("access_hint_askUnlessReadOnly") },
  askProtectedWrites: { label: copy("access_supervised_muse"), hint: copy("access_hint_askProtectedWrites") },
  askEveryTool: { label: copy("access_supervised"), hint: copy("access_hint_askEveryTool") },
  autoApprovesSafeActions: { label: copy("access_auto"), hint: copy("access_hint_autoApprovesSafeActions") },
  acceptEdits: { label: copy("access_accept_edits"), hint: copy("access_hint_acceptEdits") },
  sandboxed: { label: copy("access_auto"), hint: copy("access_hint_sandboxed") },
  aiReview: { label: copy("access_auto_muse"), hint: copy("access_hint_aiReview") },
  bypass: { label: copy("access_full"), hint: copy("access_hint_bypass") },
  unrestricted: { label: copy("access_full_muse"), hint: copy("access_hint_unrestricted") },
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
      {AccessMode.literals.map((option) => {
        const { label, hint } = behaviorCopy[accessBehavior(thread.provider, option, model)]
        return (
          <OptionRow
            key={option}
            label={label}
            icon={accessModes[option].icon}
            hint={hint}
            color={option === "full" ? theme.danger : undefined}
            selected={option === thread.accessMode}
            onPress={() =>
              option !== thread.accessMode && void updateThread({ id: thread.id, accessMode: option }, onError)
            }
          />
        )
      })}
    </Section>
  )
}
