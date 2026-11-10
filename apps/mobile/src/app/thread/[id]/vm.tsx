import type { ThreadVm, VmControl } from "@shared/domain.ts"
import { Stack, useLocalSearchParams } from "expo-router"
import { type ReactNode, useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { DesktopStream } from "@/components/desktop-stream"
import { Spinner } from "@/components/motion"
import { Button, EmptyState, Notice } from "@/components/ui"
import { useThreadConnection } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { confirmDestructive } from "@/lib/confirm"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { useThreadVm, useVms } from "@/stores/vms"

type RunningVm = Extract<ThreadVm, { status: "running" }>

export default function VmScreen() {
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const connected = useThreadConnection(id) === "connected"
  const vm = useThreadVm(id)

  useEffect(() => {
    if (connected) void useVms.getState().load(id).catch(() => {})
  }, [connected, id])

  return (
    <SafeAreaView edges={["bottom"]} style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: copy("mobile_vm_title") }} />
      {!connected && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_reconnecting_banner")} tone="attention" />
        </View>
      )}
      {vm === undefined ? <Waiting label={copy("mobile_vm_connecting")} /> : <VmState threadId={id} vm={vm} />}
    </SafeAreaView>
  )
}

function VmState({ threadId, vm }: { threadId: string; vm: ThreadVm }) {
  const action = useVmAction()
  switch (vm.status) {
    case "none":
      return <EmptyState icon="Computer" title={copy("mobile_vm_empty_title")} hint={copy("mobile_vm_empty_hint")} />
    case "starting":
      return <Waiting label={copy("mobile_vm_starting")} />
    case "failed":
      return (
        <EmptyState
          icon="Alert"
          title={copy("mobile_vm_failed_title")}
          hint={action.error ?? vm.message}
          action={
            <Button
              label={copy("mobile_vm_retry")}
              busy={action.busy}
              onPress={() => action.run(async () => replaceVm(threadId, await call("vm.start", { threadId })))}
            />
          }
        />
      )
    case "running":
      return vm.provider === "boat" ? (
        <Running threadId={threadId} vm={vm} />
      ) : (
        <EmptyState icon="Computer" title={copy("mobile_vm_desktop_only")} />
      )
  }
}

const replaceVm = (threadId: string, vm: ThreadVm) => useVms.getState().replace(threadId, vm)

function useVmAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function Running({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const theme = useTheme()
  const action = useVmAction()
  const [attempt, setAttempt] = useState(0)

  // Like the desktop panel, leaving the screen gives the VM back to the agent, which waits while the user drives.
  useEffect(
    () => () => {
      const latest = useVms.getState().byThread[threadId]
      if (latest?.status === "running" && latest.control === "user")
        void call("vm.control", { threadId, control: "agent" }).catch(() => {})
    },
    [threadId],
  )

  const setControl = (control: VmControl) =>
    action.run(async () => replaceVm(threadId, await call("vm.control", { threadId, control })))
  const stop = () =>
    confirmDestructive(copy("mobile_vm_stop_title"), copy("mobile_vm_stop_body"), copy("mobile_vm_stop"), () =>
      void action.run(() => call("vm.stop", { threadId })),
    )

  return (
    <>
      <View style={styles.flex}>
        <Desktop
          key={`${vm.sandboxId}:${attempt}`}
          threadId={threadId}
          control={vm.control}
          onReconnect={() => setAttempt(attempt + 1)}
        />
      </View>
      {vm.control === "user" && vm.agentWaiting && (
        <View style={styles.banner}>
          <Notice text={copy("mobile_vm_agent_waiting")} tone="attention" />
        </View>
      )}
      {action.error !== null && (
        <View style={styles.banner}>
          <Notice text={action.error} tone="danger" />
        </View>
      )}
      <View style={[styles.bar, { borderTopColor: theme.border }]}>
        <ControlStatus vm={vm} />
        <Button
          testID="vm-stop"
          label={copy("mobile_vm_stop")}
          variant="dangerGhost"
          disabled={action.busy}
          onPress={stop}
        />
        <Button
          testID="vm-control"
          label={copy(vm.control === "agent" ? "mobile_vm_take_control" : "mobile_vm_hand_back")}
          variant={vm.control === "agent" ? "primary" : "secondary"}
          busy={action.busy}
          onPress={() => void setControl(vm.control === "agent" ? "user" : "agent")}
        />
      </View>
    </>
  )
}

function ControlStatus({ vm }: { vm: RunningVm }) {
  const theme = useTheme()
  return (
    <Text
      accessibilityLiveRegion="polite"
      numberOfLines={1}
      style={[styles.status, { color: vm.control === "user" ? theme.text : theme.textMuted }]}
    >
      {copy(vm.control === "user" ? "mobile_vm_control_user" : "mobile_vm_control_agent")}
    </Text>
  )
}

type DesktopLink =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string; readonly shown: boolean }
  | { readonly status: "error"; readonly message: string | null }

/** The boat desktop stream, behind a shield while the agent drives so a stray touch cannot type into its screen. */
function Desktop({
  threadId,
  control,
  onReconnect,
}: {
  threadId: string
  control: VmControl
  onReconnect: () => void
}) {
  const theme = useTheme()
  const [link, setLink] = useState<DesktopLink>({ status: "loading" })

  useEffect(() => {
    let mounted = true
    call("vm.desktop.url", { threadId }).then(
      ({ url }) => mounted && setLink({ status: "ready", url, shown: false }),
      (cause: unknown) => mounted && setLink({ status: "error", message: errorText(cause) }),
    )
    return () => {
      mounted = false
    }
  }, [threadId])

  return (
    <View style={[styles.flex, { backgroundColor: theme.surface }]}>
      {link.status === "ready" && (
        <DesktopStream
          url={link.url}
          onLoad={() => setLink((current) => (current.status === "ready" ? { ...current, shown: true } : current))}
          onFail={() => setLink({ status: "error", message: null })}
        />
      )}
      {control === "agent" && <View testID="vm-shield" style={StyleSheet.absoluteFill} />}
      {(link.status === "loading" || (link.status === "ready" && !link.shown)) && (
        <Overlay>
          <Waiting label={copy("mobile_vm_connecting")} />
        </Overlay>
      )}
      {link.status === "error" && (
        <Overlay>
          <EmptyState
            icon="Alert"
            title={copy("mobile_vm_desktop_failed")}
            hint={link.message ?? undefined}
            action={<Button label={copy("mobile_vm_reconnect")} onPress={onReconnect} />}
          />
        </Overlay>
      )}
    </View>
  )
}

function Overlay({ children }: { children: ReactNode }) {
  const theme = useTheme()
  return <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.surface }]}>{children}</View>
}

function Waiting({ label }: { label: string }) {
  const theme = useTheme()
  return (
    <View accessibilityRole="progressbar" style={styles.waiting}>
      <Spinner color={theme.textMuted} />
      <Text style={[styles.waitingText, { color: theme.textMuted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: { paddingHorizontal: 12, paddingVertical: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  status: { flex: 1, fontSize: 14 },
  waiting: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 24 },
  waitingText: { fontSize: 15 },
})
