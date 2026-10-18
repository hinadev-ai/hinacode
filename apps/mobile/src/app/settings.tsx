import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import type { RpcRequest } from "@shared/contract.ts"
import { AccessMode, type Settings } from "@shared/domain.ts"
import Constants from "expo-constants"
import { useEffect, useState } from "react"
import { Alert, AppState, Linking, Platform, ScrollView, StyleSheet, View } from "react-native"
import type { IconName } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import { Footnote, SettingsGroup, SettingsRow, SwitchRow } from "@/components/settings-rows"
import { OptionRow, Sheet } from "@/components/sheet"
import { Button, ConnectionBadge, Notice, SegmentedControl, type Segment } from "@/components/ui"
import { useTheme } from "@/hooks/use-theme"
import { call, disconnect, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import {
  getNotificationPermission,
  type NotificationPermission,
  requestNotificationPermission,
} from "@/lib/notifications"
import type { Appearance, Preferences } from "@/lib/preferences"
import { clearTarget } from "@/lib/storage"
import { useModels } from "@/stores/models"
import { usePreferences } from "@/stores/preferences"

export default function SettingsScreen() {
  const theme = useTheme()
  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <PhoneSettings />
      <DesktopSettings />
      <ConnectionSettings />
      <SettingsGroup title={copy("mobile_settings_about")}>
        <SettingsRow
          icon="RiSmartphoneLine"
          label={copy("mobile_settings_version", { version: Constants.expoConfig?.version ?? "" })}
        />
      </SettingsGroup>
    </ScrollView>
  )
}

const appearanceSegments: readonly Segment<Appearance>[] = [
  { value: "system", label: copy("mobile_settings_appearance_system"), icon: "RiContrast2Line" },
  { value: "light", label: copy("mobile_settings_appearance_light"), icon: "RiSunLine" },
  { value: "dark", label: copy("mobile_settings_appearance_dark"), icon: "RiMoonLine" },
]

type NotificationKind = keyof Preferences["notifications"]

const notificationKinds: readonly { kind: NotificationKind; label: string; icon: IconName }[] = [
  { kind: "completed", label: copy("mobile_settings_notify_completed"), icon: "RiCheckboxCircleLine" },
  { kind: "needsInput", label: copy("mobile_settings_notify_needs_input"), icon: "RiQuestionLine" },
  { kind: "failed", label: copy("mobile_settings_notify_failed"), icon: "RiErrorWarningLine" },
]

function PhoneSettings() {
  const appearance = usePreferences((state) => state.appearance)
  const notifications = usePreferences((state) => state.notifications)
  const set = usePreferences((state) => state.set)
  const [permission, setPermission] = useNotificationPermission()
  return (
    <>
      <SettingsGroup title={copy("mobile_settings_phone")}>
        <View style={styles.segmentRow}>
          <SegmentedControl
            segments={appearanceSegments}
            value={appearance}
            onChange={(value) => set({ appearance: value })}
            accessibilityLabel={copy("mobile_settings_appearance")}
          />
        </View>
      </SettingsGroup>
      <SettingsGroup
        title={copy("mobile_settings_notifications")}
        footnote={copy("mobile_settings_notifications_footnote")}
      >
        {notificationKinds.map(({ kind, label, icon }) => (
          <SwitchRow
            key={kind}
            icon={icon}
            label={label}
            value={notifications[kind]}
            onChange={(value) => set({ notifications: { ...notifications, [kind]: value } })}
          />
        ))}
        {permission !== null && permission !== "granted" && (
          <NotificationPermissionRow permission={permission} onChange={setPermission} />
        )}
      </SettingsGroup>
    </>
  )
}

/** The system permission, read again on every return to the foreground, since it changes in system settings. */
function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission | null>(null)
  useEffect(() => {
    const read = () => void getNotificationPermission().then(setPermission)
    read()
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") read()
    })
    return () => subscription.remove()
  }, [])
  return [permission, setPermission] as const
}

function NotificationPermissionRow({
  permission,
  onChange,
}: {
  permission: Exclude<NotificationPermission, "granted">
  onChange: (permission: NotificationPermission) => void
}) {
  const [asking, setAsking] = useState(false)
  const ask = async () => {
    setAsking(true)
    try {
      onChange(await requestNotificationPermission())
    } finally {
      setAsking(false)
    }
  }
  switch (permission) {
    case "undetermined":
      return (
        <View style={styles.permission}>
          <Button
            icon="RiNotification3Line"
            label={copy("mobile_settings_notifications_allow")}
            variant="primary"
            busy={asking}
            onPress={() => void ask()}
          />
        </View>
      )
    case "denied":
      return (
        <View style={styles.permission}>
          <Notice tone="attention" text={copy("mobile_settings_notifications_denied")} />
          {Platform.OS !== "web" && (
            <Button label={copy("mobile_settings_open_settings")} onPress={() => void Linking.openSettings()} />
          )}
        </View>
      )
    case "unsupported":
      return (
        <View style={styles.permission}>
          <Footnote text={copy("mobile_settings_notifications_unsupported")} />
        </View>
      )
  }
}

type SettingsPatch = RpcRequest<"settings.set">

const accessModes: Record<AccessMode, { label: string; hint: string; icon: IconName }> = {
  supervised: {
    label: copy("mobile_settings_access_supervised"),
    hint: copy("mobile_settings_access_supervised_hint"),
    icon: "RiShieldUserLine",
  },
  auto: {
    label: copy("mobile_settings_access_auto"),
    hint: copy("mobile_settings_access_auto_hint"),
    icon: "RiShieldCheckLine",
  },
  full: {
    label: copy("mobile_settings_access_full"),
    hint: copy("mobile_settings_access_full_hint"),
    icon: "RiLockUnlockLine",
  },
}

const agents: readonly { provider: ProviderId; label: string; icon: IconName }[] = [
  { provider: "claude", label: copy("mobile_settings_agent_claude"), icon: "RiClaudeFill" },
  { provider: "codex", label: copy("mobile_settings_agent_codex"), icon: "RiOpenaiFill" },
  { provider: "muse", label: copy("mobile_settings_agent_muse"), icon: "RiMetaFill" },
]

/**
 * The desktop's settings, loaded once per handshake. Writes show at once and roll back when the desktop
 * refuses them.
 */
function useDesktopSettings() {
  const generation = useConnection((state) => state.generation)
  const [attempt, setAttempt] = useState(0)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    call("settings.get", undefined).then(
      (loaded) => {
        if (!current) return
        setSettings(loaded)
        setLoadError(null)
      },
      (cause) => current && setLoadError(errorText(cause)),
    )
    return () => {
      current = false
    }
  }, [generation, attempt])

  const retry = () => {
    setLoadError(null)
    setAttempt((value) => value + 1)
  }

  const write = (previous: Settings, patch: SettingsPatch) => {
    setSettings({ ...previous, ...patch })
    setWriteError(null)
    call("settings.set", patch).then(setSettings, (cause) => {
      setSettings(previous)
      setWriteError(errorText(cause))
    })
  }

  return { settings, loadError, writeError, retry, write }
}

function DesktopSettings() {
  const theme = useTheme()
  const offline = useConnection((state) => state.status !== "connected")
  const { settings, loadError, writeError, retry, write } = useDesktopSettings()
  const [picking, setPicking] = useState<ProviderId | null>(null)

  if (settings === null) {
    return (
      <SettingsGroup title={copy("mobile_settings_desktop")}>
        {loadError !== null ? (
          <LoadFailed text={copy("mobile_settings_load_failed", { message: loadError })} onRetry={retry} />
        ) : (
          <Reveal style={styles.loading}>
            <Spinner color={theme.textMuted} />
            <Footnote text={copy("mobile_settings_loading")} />
          </Reveal>
        )}
      </SettingsGroup>
    )
  }

  const pickModel = (provider: ProviderId, id: string | null) => {
    setPicking(null)
    if (settings.defaultModel[provider] === id) return
    write(settings, { defaultModel: { ...settings.defaultModel, [provider]: id } })
  }

  return (
    <>
      {writeError !== null && (
        <Notice tone="danger" text={copy("mobile_settings_save_failed", { message: writeError })} />
      )}
      {loadError !== null && (
        <LoadFailed text={copy("mobile_settings_load_failed", { message: loadError })} onRetry={retry} />
      )}
      <SettingsGroup
        title={copy("mobile_settings_access")}
        footnote={copy(offline ? "mobile_settings_offline" : "mobile_settings_desktop_footnote")}
      >
        {AccessMode.literals.map((mode) => (
          <OptionRow
            key={mode}
            label={accessModes[mode].label}
            hint={accessModes[mode].hint}
            icon={accessModes[mode].icon}
            color={offline ? theme.textMuted : mode === "full" ? theme.danger : undefined}
            selected={settings.defaultAccessMode === mode}
            onPress={() => {
              if (!offline && settings.defaultAccessMode !== mode) write(settings, { defaultAccessMode: mode })
            }}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title={copy("mobile_settings_default_model")}>
        {agents.map(({ provider, label, icon }) => (
          <DefaultModelRow
            key={provider}
            provider={provider}
            label={label}
            icon={icon}
            model={settings.defaultModel[provider]}
            disabled={offline}
            onPress={() => setPicking(provider)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title={copy("mobile_settings_archiving")} footnote={copy("mobile_settings_archive_footnote")}>
        <SwitchRow
          icon="RiGitMergeLine"
          label={copy("mobile_settings_archive_when_merged")}
          value={settings.archive.whenMerged}
          disabled={offline}
          onChange={(whenMerged) => write(settings, { archive: { ...settings.archive, whenMerged } })}
        />
        <SwitchRow
          icon="RiArchiveLine"
          label={copy("mobile_settings_archive_remove_worktree")}
          value={settings.archive.removeWorktree}
          disabled={offline}
          onChange={(removeWorktree) => write(settings, { archive: { ...settings.archive, removeWorktree } })}
        />
      </SettingsGroup>
      {picking !== null && (
        <ModelSheet
          provider={picking}
          current={settings.defaultModel[picking]}
          onPick={(id) => pickModel(picking, id)}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  )
}

function LoadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <View style={styles.permission}>
      <Notice tone="danger" text={text} />
      <Button icon="RiRefreshLine" label={copy("mobile_settings_retry")} onPress={onRetry} />
    </View>
  )
}

const modelLabel = (models: readonly ModelInfo[] | undefined, id: string | null) =>
  id === null ? copy("mobile_settings_agent_default") : (models?.find((model) => model.id === id)?.label ?? id)

function DefaultModelRow({
  provider,
  label,
  icon,
  model,
  disabled,
  onPress,
}: {
  provider: ProviderId
  label: string
  icon: IconName
  model: string | null
  disabled: boolean
  onPress: () => void
}) {
  const models = useModels((state) => state.byProvider[provider])
  const load = useModels((state) => state.load)
  // Only to turn a stored id into its label; the id stays readable if the agent cannot list its models.
  useEffect(() => {
    if (model !== null) load(provider).catch(() => undefined)
  }, [model, provider, load])
  return (
    <SettingsRow icon={icon} label={label} value={modelLabel(models, model)} disabled={disabled} onPress={onPress} />
  )
}

function ModelSheet({
  provider,
  current,
  onPick,
  onClose,
}: {
  provider: ProviderId
  current: string | null
  onPick: (id: string | null) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const models = useModels((state) => state.byProvider[provider])
  const load = useModels((state) => state.load)
  const [attempt, setAttempt] = useState(0)
  const [error, setError] = useState<{ attempt: number; message: string } | null>(null)
  const agent = agents.find((entry) => entry.provider === provider)?.label ?? provider

  useEffect(() => {
    load(provider).catch((cause) => setError({ attempt, message: errorText(cause) }))
  }, [load, provider, attempt])

  const failure = error?.attempt === attempt ? error.message : null
  return (
    <Sheet title={copy("mobile_settings_model_sheet_title", { agent })} open onClose={onClose}>
      <View>
        <OptionRow
          label={copy("mobile_settings_agent_default")}
          hint={copy("mobile_settings_agent_default_hint")}
          selected={current === null}
          onPress={() => onPick(null)}
        />
        {models?.map((model) => (
          <OptionRow
            key={model.id}
            label={model.label}
            selected={current === model.id}
            onPress={() => onPick(model.id)}
          />
        ))}
      </View>
      {failure !== null ? (
        <LoadFailed
          text={copy("mobile_settings_models_failed", { message: failure })}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : (
        models === undefined && (
          <Reveal style={styles.loading}>
            <Spinner color={theme.textMuted} />
            <Footnote text={copy("mobile_settings_models_loading")} />
          </Reveal>
        )
      )}
    </Sheet>
  )
}

function ConnectionSettings() {
  const status = useConnection((state) => state.status)
  const target = useConnection((state) => state.target)
  const extraHosts = target?.hosts.slice(1) ?? []
  return (
    <SettingsGroup
      title={copy("mobile_settings_connection")}
      footnote={
        <>
          {extraHosts.length > 0 && `${copy("mobile_settings_more_hosts", { hosts: extraHosts.join(", ") })}\n`}
          {copy("mobile_settings_connection_footnote")}
        </>
      }
    >
      <SettingsRow icon="RiWifiLine" label={copy("mobile_settings_status")}>
        <ConnectionBadge status={status} />
      </SettingsRow>
      {target !== null && (
        <SettingsRow
          icon="RiComputerLine"
          label={copy("mobile_settings_address")}
          value={`${target.hosts[0]}:${target.port}`}
          monospace
        />
      )}
      <View style={styles.permission}>
        <Button
          icon="RiLinkUnlinkM"
          variant="danger"
          label={copy("mobile_settings_disconnect")}
          onPress={confirmDisconnect}
        />
      </View>
    </SettingsGroup>
  )
}

const forget = () => void clearTarget().then(disconnect)

// react-native-web's Alert shows no buttons, so the browser's own confirm stands in.
function confirmDisconnect() {
  const title = copy("mobile_settings_disconnect_title")
  const message = copy("mobile_settings_disconnect_message")
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) forget()
    return
  }
  Alert.alert(title, message, [
    { text: copy("mobile_settings_cancel"), style: "cancel" },
    { text: copy("mobile_settings_disconnect"), style: "destructive", onPress: forget },
  ])
}

const styles = StyleSheet.create({
  content: { gap: 24, padding: 16, paddingBottom: 40 },
  segmentRow: { padding: 8 },
  permission: { gap: 8, padding: 12 },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16 },
})
