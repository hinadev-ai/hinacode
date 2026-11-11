import type { ModelInfo, ProviderId } from "@shared/agent.ts"
import type { RpcRequest } from "@shared/contract.ts"
import { AccessMode, applySettingsPatch, type Settings } from "@shared/domain.ts"
import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Cause, Effect, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import Constants from "expo-constants"
import { useState } from "react"
import { router } from "expo-router"
import { AppState, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native"
import { forgetServer } from "@/lib/start-app"
import { Icon, type IconName } from "@/components/icon"
import { Reveal, Spinner } from "@/components/motion"
import { RelayAccountSection } from "@/components/relay-account"
import {
  CheckRow,
  Footnote,
  SettingsGroup,
  SettingsHeading,
  SettingsRow,
  SwitchRow,
} from "@/components/settings-rows"
import { ServerSelect } from "@/components/server-select"
import { OptionRow, Sheet } from "@/components/sheet"
import { Button, ConnectionBadge, Notice, SegmentedControl, type Segment } from "@/components/ui"
import { serverName } from "@/hooks/use-server"
import { useScheme, useTheme } from "@/hooks/use-theme"
import { HIT, mono, type Palette, ProviderColors, radius } from "@/constants/theme"
import { call, type ConnectionStatus, reconnectNow, type RpcError, type Server, useConnection } from "@/lib/connection"
import { confirmDestructive } from "@/lib/confirm"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import {
  getNotificationPermission,
  type NotificationPermission,
  requestNotificationPermission,
} from "@/lib/notifications"
import type { Appearance, Preferences } from "@/lib/preferences"
import { rpcFamily } from "@/lib/remote"
import { modelsLoadAtom, modelsOn, modelsRelistAtom, useModels } from "@/stores/models"
import { usePreferences } from "@/stores/preferences"

export default function SettingsScreen() {
  const theme = useTheme()
  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <ServerSettings />
      <AppearanceSetting />
      <DesktopSettings />
      <NotificationSettings />
      <RelayAccountSection />
      <SettingsGroup title={copy("mobile_settings_about")}>
        <SettingsRow
          icon="Phone"
          label={copy("mobile_settings_version", { version: Constants.expoConfig?.version ?? "" })}
        />
      </SettingsGroup>
    </ScrollView>
  )
}

const appearanceSegments: readonly Segment<Appearance>[] = [
  { value: "system", label: copy("mobile_settings_appearance_system") },
  { value: "light", label: copy("mobile_settings_appearance_light") },
  { value: "dark", label: copy("mobile_settings_appearance_dark") },
]

type NotificationKind = keyof Preferences["notifications"]

const notificationKinds: readonly { kind: NotificationKind; label: string; icon: IconName }[] = [
  { kind: "completed", label: copy("mobile_settings_notify_completed"), icon: "CheckCircle" },
  { kind: "needsInput", label: copy("mobile_settings_notify_needs_input"), icon: "Question" },
  { kind: "failed", label: copy("mobile_settings_notify_failed"), icon: "Warning" },
]

function AppearanceSetting() {
  const appearance = usePreferences((state) => state.appearance)
  const set = usePreferences((state) => state.set)
  return (
    <View style={styles.appearance}>
      <SettingsHeading title={copy("mobile_settings_appearance")} />
      <SegmentedControl
        segments={appearanceSegments}
        value={appearance}
        onChange={(value) => set({ appearance: value })}
        accessibilityLabel={copy("mobile_settings_appearance")}
      />
    </View>
  )
}

function NotificationSettings() {
  const notifications = usePreferences((state) => state.notifications)
  const set = usePreferences((state) => state.set)
  const permission = Option.getOrNull(AsyncResult.value(useAtomValue(notificationPermissionAtom)))
  const readPermission = useAtomRefresh(notificationPermissionAtom)
  return (
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
        <NotificationPermissionRow permission={permission} onAnswered={readPermission} />
      )}
    </SettingsGroup>
  )
}

const notificationPermissionAtom = Atom.make((get) => {
  const foreground = AppState.addEventListener("change", (state) => state === "active" && get.refreshSelf())
  get.addFinalizer(() => foreground.remove())
  return Effect.promise(getNotificationPermission)
})

function NotificationPermissionRow({
  permission,
  onAnswered,
}: {
  permission: Exclude<NotificationPermission, "granted">
  onAnswered: () => void
}) {
  const [asking, setAsking] = useState(false)
  const ask = async () => {
    setAsking(true)
    await requestNotificationPermission()
      .then(() => onAnswered())
      .finally(() => setAsking(false))
  }
  switch (permission) {
    case "undetermined":
      return (
        <View style={styles.permission}>
          <Button
            icon="Bell"
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
    icon: "ShieldUser",
  },
  auto: {
    label: copy("mobile_settings_access_auto"),
    hint: copy("mobile_settings_access_auto_hint"),
    icon: "Shield",
  },
  full: {
    label: copy("mobile_settings_access_full"),
    hint: copy("mobile_settings_access_full_hint"),
    icon: "Unlock",
  },
}

const agents: readonly { provider: ProviderId; label: string; icon: IconName }[] = [
  { provider: "claude", label: copy("mobile_settings_agent_claude"), icon: "RiClaudeFill" },
  { provider: "codex", label: copy("mobile_settings_agent_codex"), icon: "RiOpenaiFill" },
  { provider: "muse", label: copy("mobile_settings_agent_muse"), icon: "RiMetaFill" },
  { provider: "opencode", label: copy("mobile_settings_agent_opencode"), icon: "OpencodeMark" },
  { provider: "magpie", label: copy("mobile_settings_agent_magpie"), icon: "MagpieMark" },
]

const settingsAtom = rpcFamily("settings.get")
const noServerAtom = Atom.make(AsyncResult.initial<Settings, RpcError>())

function useDesktopSettings(server: string | undefined) {
  const atom = server === undefined ? noServerAtom : settingsAtom(undefined, server)
  const result = useAtomValue(atom)
  const retry = useAtomRefresh(atom)
  const loaded = Option.getOrNull(AsyncResult.value(result))
  const loadError = AsyncResult.isFailure(result) && !result.waiting ? errorText(Cause.squash(result.cause)) : null
  const [written, setWritten] = useState<{ readonly over: Settings | null; readonly settings: Settings } | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const settings = written !== null && written.over === loaded ? written.settings : loaded
  const show = (next: Settings) => setWritten({ over: loaded, settings: next })

  const write = (previous: Settings, patch: SettingsPatch) => {
    show(applySettingsPatch(previous, patch))
    setWriteError(null)
    call("settings.set", patch, { server }).then(show, (cause) => {
      show(previous)
      setWriteError(errorText(cause))
    })
  }

  return { settings, loadError, writeError, retry, write }
}

function DesktopSettings() {
  const servers = useConnection((state) => state.servers)
  const [chosen, setChosen] = useState<string | null>(null)
  const server =
    servers.find((entry) => entry.id === chosen) ?? servers.find((entry) => entry.status === "connected") ?? servers[0]
  return (
    <>
      {servers.length > 1 && server !== undefined && (
        <SettingsGroup title={copy("mobile_settings_server_settings")}>
          <View style={styles.serverPicker}>
            <ServerSelect
              testID="settings-server"
              label={copy("mobile_settings_server_settings")}
              servers={servers}
              value={server}
              onChange={setChosen}
            />
          </View>
        </SettingsGroup>
      )}
      <ServerPreferences key={server?.id} server={server} />
    </>
  )
}

function ServerPreferences({ server }: { server: Server | undefined }) {
  const theme = useTheme()
  const offline = server?.status !== "connected"
  const { settings, loadError, writeError, retry, write } = useDesktopSettings(server?.id)
  const [picking, setPicking] = useState<ProviderId | null>(null)

  if (settings === null) {
    return (
      <SettingsGroup title={server === undefined ? copy("mobile_settings_servers") : serverName(server)}>
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
    write(settings, { defaultModel: { [provider]: id } })
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
        footnote={copy(offline ? "mobile_settings_server_offline" : "mobile_settings_server_footnote", {
          server: server === undefined ? "" : serverName(server),
        })}
      >
        {AccessMode.literals.map((mode) => (
          <CheckRow
            key={mode}
            label={accessModes[mode].label}
            hint={accessModes[mode].hint}
            icon={accessModes[mode].icon}
            color={mode === "full" ? theme.danger : undefined}
            disabled={offline}
            selected={settings.defaultAccessMode === mode}
            onPress={() => {
              if (settings.defaultAccessMode !== mode) write(settings, { defaultAccessMode: mode })
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
            server={server?.id}
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
          onChange={(whenMerged) => write(settings, { archive: { whenMerged } })}
        />
        <SwitchRow
          icon="Archive"
          label={copy("mobile_settings_archive_remove_worktree")}
          value={settings.archive.removeWorktree}
          disabled={offline}
          onChange={(removeWorktree) => write(settings, { archive: { removeWorktree } })}
        />
      </SettingsGroup>
      {picking !== null && (
        <ModelSheet
          provider={picking}
          current={settings.defaultModel[picking]}
          server={server?.id}
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
      <Button icon="Refresh" label={copy("mobile_settings_retry")} onPress={onRetry} />
    </View>
  )
}

const noModelToLabelAtom = Atom.make(AsyncResult.initial<void, unknown>())

const modelLabel = (models: readonly ModelInfo[] | undefined, id: string | null) =>
  id === null ? copy("mobile_settings_agent_default") : (models?.find((model) => model.id === id)?.label ?? id)

function DefaultModelRow({
  provider,
  label,
  icon,
  model,
  server,
  disabled,
  onPress,
}: {
  provider: ProviderId
  label: string
  icon: IconName
  model: string | null
  server: string | undefined
  disabled: boolean
  onPress: () => void
}) {
  const scheme = useScheme()
  const models = useModels((state) => modelsOn(state, server, provider))
  useAtomMount(model === null ? noModelToLabelAtom : modelsLoadAtom(server, provider))
  return (
    <SettingsRow
      icon={icon}
      iconColor={ProviderColors[scheme][provider]}
      label={label}
      value={modelLabel(models, model)}
      monospace={model !== null}
      disabled={disabled}
      onPress={onPress}
    />
  )
}

function ModelSheet({
  provider,
  current,
  server,
  onPick,
  onClose,
}: {
  provider: ProviderId
  current: string | null
  server: string | undefined
  onPick: (id: string | null) => void
  onClose: () => void
}) {
  const theme = useTheme()
  const models = useModels((state) => modelsOn(state, server, provider))
  const loading = useAtomValue(modelsRelistAtom(server, provider))
  const retry = useAtomRefresh(modelsRelistAtom(server, provider))
  const agent = agents.find((entry) => entry.provider === provider)?.label ?? provider
  const failure = AsyncResult.isFailure(loading) && !loading.waiting ? errorText(Cause.squash(loading.cause)) : null
  return (
    <Sheet title={copy("mobile_settings_model_sheet_title", { agent })} open onClose={onClose} fit>
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
          onRetry={retry}
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

function ServerSettings() {
  const servers = useConnection((state) => state.servers)
  const environmentFilter = usePreferences((state) => state.environmentFilter)
  const set = usePreferences((state) => state.set)
  const [openId, setOpenId] = useState<string | null>(null)
  const open = servers.find((server) => server.id === openId)
  return (
    <>
      <SettingsGroup footnote={copy("mobile_settings_connection_footnote")}>
        {servers.map((server) => (
          <ServerRow key={server.id} server={server} onPress={() => setOpenId(server.id)} />
        ))}
        <SettingsRow
          icon="Plus"
          label={copy("mobile_settings_add_server")}
          onPress={() => router.push("/server/new")}
        />
        {servers.length > 1 && (
          <SwitchRow
            icon="CloudOff"
            label={copy("mobile_settings_hide_offline_servers")}
            value={environmentFilter.hideOffline}
            onChange={(hideOffline) => set({ environmentFilter: { ...environmentFilter, hideOffline } })}
          />
        )}
      </SettingsGroup>
      {open !== undefined && <ServerSheet server={open} onClose={() => setOpenId(null)} />}
    </>
  )
}

const connectionLabel: Record<ConnectionStatus, string> = {
  connected: copy("mobile_connection_connected"),
  connecting: copy("mobile_connection_connecting"),
  offline: copy("mobile_connection_offline"),
  unauthorized: copy("mobile_connection_unauthorized"),
}

const connectionColor = (theme: Palette): Record<ConnectionStatus, string> => ({
  connected: theme.running,
  connecting: theme.textMuted,
  offline: theme.attention,
  unauthorized: theme.danger,
})

function ServerRow({ server, onPress }: { server: Server; onPress: () => void }) {
  const theme = useTheme()
  const name = serverName(server)
  const status = connectionLabel[server.status]
  const line = server.source === "relay" ? copy("mobile_settings_server_via_relay", { status }) : status
  return (
    <Pressable
      testID={`server-row-${server.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${copy("mobile_connection_label", { status: line })}`}
      onPress={onPress}
      style={({ pressed }) => [styles.serverRow, pressed && { backgroundColor: theme.surface }]}
    >
      <View style={[styles.serverTile, { backgroundColor: theme.text }]}>
        <Icon name="Computer" size={22} color={theme.background} />
      </View>
      <View style={styles.serverText}>
        <Text numberOfLines={1} style={[styles.serverName, { color: theme.text }]}>
          {name}
        </Text>
        <View testID="connection-status" style={styles.serverLine}>
          <View style={[styles.dot, { backgroundColor: connectionColor(theme)[server.status] }]} />
          <Text numberOfLines={1} style={[styles.serverStatus, { color: theme.textMuted }]}>
            {line}
          </Text>
        </View>
      </View>
      <Icon name="ChevronRight" size={18} color={theme.textMuted} />
    </Pressable>
  )
}

function ServerSheet({ server, onClose }: { server: Server; onClose: () => void }) {
  const theme = useTheme()
  const forget = () => {
    onClose()
    forgetServer(server.id)
  }
  return (
    <Sheet title={serverName(server)} open onClose={onClose} fit>
      <View style={styles.permission}>
        <View style={styles.sheetStatus}>
          <ConnectionBadge status={server.status} />
          {server.source === "relay" && (
            <Text style={[styles.source, { color: theme.textMuted }]}>{copy("mobile_relay_from_relay")}</Text>
          )}
        </View>
        {server.error !== null && <Notice tone="danger" text={server.error} />}
        {server.relay !== null && <Text style={[styles.address, { color: theme.textMuted }]}>{server.relay}</Text>}
        {server.hosts.map((host) => (
          <Text key={host} style={[styles.address, { color: theme.textMuted }]}>{`${host}:${server.port}`}</Text>
        ))}
        {server.status === "offline" && (
          <Button
            icon="Refresh"
            label={copy("mobile_settings_server_reconnect")}
            onPress={() => reconnectNow(server.id)}
          />
        )}
        {server.status === "unauthorized" && (
          <Button
            icon="RiQrScanLine"
            variant="primary"
            label={copy("mobile_settings_server_pair_again")}
            onPress={() => {
              onClose()
              router.push("/server/new")
            }}
          />
        )}
        {server.source === "relay" ? (
          <Footnote text={copy("mobile_relay_forget_hint")} />
        ) : (
          <Button
            icon="Unlink"
            variant="danger"
            label={copy("mobile_settings_server_forget")}
            onPress={() => confirmForget(serverName(server), forget)}
          />
        )}
      </View>
    </Sheet>
  )
}

const confirmForget = (name: string, forget: () => void) =>
  confirmDestructive(
    copy("mobile_settings_server_forget_title", { server: name }),
    copy("mobile_settings_server_forget_message"),
    copy("mobile_settings_server_forget"),
    forget,
  )

const styles = StyleSheet.create({
  content: { gap: 24, padding: 16, paddingBottom: 40 },
  appearance: { gap: 8 },
  permission: { gap: 8, padding: 12 },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, padding: 16 },
  sheetStatus: { flexDirection: "row", alignItems: "center", gap: 8 },
  serverRow: { minHeight: HIT, flexDirection: "row", alignItems: "center", gap: 12, padding: 16 },
  serverTile: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  serverText: { flex: 1, minWidth: 0, gap: 2 },
  serverName: { fontSize: 17, fontWeight: "600" },
  serverLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  serverStatus: { flexShrink: 1, fontSize: 14 },
  source: { fontSize: 13 },
  address: { fontFamily: mono, fontSize: 13 },
  serverPicker: { padding: 8 },
})
