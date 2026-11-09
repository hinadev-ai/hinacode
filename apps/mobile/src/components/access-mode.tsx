import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import { AccessMode, type Thread } from "@shared/domain.ts"
import { useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { useThreadModels } from "@/components/composer"
import { updateThread } from "@/stores/threads"
import { Icon, type IconName } from "@/components/icon"
import { PressableScale } from "@/components/motion"
import { OptionRow, Sheet } from "@/components/sheet"
import { Notice } from "@/components/ui"
import { HIT, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const accessModes: Record<AccessMode, { label: string; icon: IconName }> = {
  supervised: { label: copy("mobile_settings_access_supervised"), icon: "ShieldUser" },
  auto: { label: copy("mobile_settings_access_auto"), icon: "Shield" },
  full: { label: copy("mobile_settings_access_full"), icon: "Unlock" },
}

/** What each mode lets through, which differs by agent and, for Claude's auto mode, by model. */
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

/**
 * The thread's access mode as a pill that opens a sheet of the modes, each with what it lets through. `compact`
 * drops the label, for when Stop shares the bar and a phone is too narrow for both.
 */
export function AccessModePicker({ thread, compact = false }: { thread: Thread; compact?: boolean }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { current } = useThreadModels(thread)
  const mode = accessModes[thread.accessMode]
  const color = thread.accessMode === "full" ? theme.danger : theme.text
  const close = () => {
    setError(null)
    setOpen(false)
  }
  return (
    <>
      <PressableScale
        testID="thread-access-mode"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_composer_access")}
        accessibilityValue={{ text: mode.label }}
        onPress={() => setOpen(true)}
        style={[styles.pill, { backgroundColor: theme.surface }]}
      >
        <Icon name={mode.icon} size={16} color={color} />
        {!compact && (
          <Text numberOfLines={1} style={[styles.label, { color }]}>
            {mode.label}
          </Text>
        )}
        <Icon name="ChevronDown" size={12} color={theme.textMuted} />
      </PressableScale>
      <Sheet title={copy("mobile_composer_access")} open={open} onClose={close} fit>
        <View role="radiogroup" accessibilityLabel={copy("mobile_composer_access")}>
          {AccessMode.literals.map((option) => (
            <OptionRow
              key={option}
              label={accessModes[option].label}
              icon={accessModes[option].icon}
              hint={accessHint(option, thread, current)}
              color={option === "full" ? theme.danger : undefined}
              selected={option === thread.accessMode}
              onPress={() =>
                option !== thread.accessMode && void updateThread({ id: thread.id, accessMode: option }, setError)
              }
            />
          ))}
        </View>
        {error !== null && <Notice text={error} tone="danger" />}
      </Sheet>
    </>
  )
}

const styles = StyleSheet.create({
  pill: {
    height: HIT,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    borderRadius: radius.full,
  },
  label: { flexShrink: 1, fontSize: 15, fontWeight: "600" },
})
