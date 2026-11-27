import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { ThreadVm } from "@shared/domain.ts"
import { streamVmScreen, type VmScreenStream } from "@shared/vmScreenStream.ts"
import { Base64 } from "effect/encoding"
import { AsyncResult } from "effect/reactivity"
import { Cause, Option, Result } from "effect"
import { randomUUID } from "expo-crypto"
import { Stack, useLocalSearchParams } from "expo-router"
import { useHeaderHeight } from "expo-router/react-navigation"
import { type Ref, type RefObject, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react"
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { Failure } from "@/components/files"
import { Icon, type IconName } from "@/components/icon"
import { useAction } from "@/components/request-cards"
import { Button, Notice, SegmentedControl } from "@/components/ui"
import { VmScreenView, type VmScreenViewHandle } from "@/components/vm-screen-view"
import { HIT, radius } from "@/constants/theme"
import { useVmScreenServed } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { call, useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { threadVm } from "@/lib/vm"
import type { ScreenFit, ScreenKey, ScreenMessage } from "@/vm-screen/controller"

type RunningVm = Extract<ThreadVm, { status: "running" }>
type Connection =
  | { readonly status: "connecting" }
  | { readonly status: "connected" }
  | { readonly status: "lost"; readonly reason: string | null }

const fitSegments = [
  { value: "fit", label: copy("mobile_vm_fit") },
  { value: "actual", label: copy("mobile_vm_actual") },
] as const satisfies readonly { value: ScreenFit; label: string }[]

const keys: readonly { key: ScreenKey; label: string; icon?: IconName; accessibilityLabel?: string }[] = [
  { key: "Escape", label: copy("mobile_vm_key_escape") },
  { key: "Tab", label: copy("mobile_vm_key_tab") },
  { key: "Left", label: "", icon: "ArrowLeft", accessibilityLabel: copy("mobile_vm_key_left") },
  { key: "Up", label: "", icon: "ArrowUp", accessibilityLabel: copy("mobile_vm_key_up") },
  { key: "Down", label: "", icon: "ArrowDown", accessibilityLabel: copy("mobile_vm_key_down") },
  { key: "Right", label: "", icon: "ArrowRight", accessibilityLabel: copy("mobile_vm_key_right") },
  { key: "BackSpace", label: "⌫", accessibilityLabel: copy("mobile_vm_key_backspace") },
  { key: "Return", label: "⏎", accessibilityLabel: copy("mobile_vm_key_return") },
]

export default function VmScreenRoute() {
  const theme = useTheme()
  const { id } = useLocalSearchParams<{ id: string }>()
  const vmAtom = threadVm({ threadId: id })
  const result = useAtomValue(vmAtom)
  const retry = useAtomRefresh(vmAtom)
  const vm = Option.getOrUndefined(AsyncResult.value(result))
  const served = useVmScreenServed(id)
  const headerHeight = useHeaderHeight()
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.flex, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ title: copy("mobile_vm_title") }} />
      {AsyncResult.isFailure(result) && !result.waiting ? (
        <Failure message={errorText(Cause.squash(result.cause))} onRetry={retry} />
      ) : vm === undefined ? (
        <Message text={null} />
      ) : !served ? (
        <Message text={copy("mobile_vm_update_desktop")} />
      ) : vm.status !== "running" ? (
        <Message text={copy("mobile_vm_none")} />
      ) : vm.provider === "boat" ? (
        <Message text={copy("mobile_vm_boat")} />
      ) : (
        <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
          <RunningScreen threadId={id} vm={vm} />
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  )
}

function Message({ text }: { text: string | null }) {
  const theme = useTheme()
  return (
    <View style={styles.message}>
      {text === null ? (
        <ActivityIndicator color={theme.textMuted} />
      ) : (
        <Text style={[styles.messageText, { color: theme.textMuted }]}>{text}</Text>
      )}
    </View>
  )
}

function RunningScreen({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const [fit, setFit] = useState<ScreenFit>("fit")
  const [session, setSession] = useState(0)
  const screen = useRef<ScreenSessionHandle>(null)
  return (
    <View style={[styles.flex, styles.footerSpace]}>
      <ControlBar threadId={threadId} vm={vm} />
      <ScreenSession
        key={session}
        ref={screen}
        threadId={threadId}
        user={vm.control === "user"}
        fit={fit}
        onReconnect={() => setSession(session + 1)}
      />
      <View style={styles.toolbar}>
        <SegmentedControl<ScreenFit>
          segments={fitSegments}
          value={fit}
          onChange={setFit}
          accessibilityLabel={copy("mobile_vm_zoom")}
          style={styles.flex}
        />
      </View>
      {vm.control === "user" && <VmKeyboard screen={screen} />}
    </View>
  )
}

type ControlState = "agent" | "user" | "waiting"

const controlState = (vm: RunningVm): ControlState =>
  vm.control === "agent" ? "agent" : vm.request === undefined ? "user" : "waiting"

const controlLabels = {
  agent: "vm_control_agent",
  user: "vm_control_user",
  waiting: "vm_hand_over_waiting",
} as const satisfies Record<ControlState, string>

function ControlBar({ threadId, vm }: { threadId: string; vm: RunningVm }) {
  const theme = useTheme()
  const control = useAction()
  const state = controlState(vm)
  const dot = { agent: theme.textMuted, user: theme.running, waiting: theme.attention }[state]
  const next = vm.control === "user" ? "agent" : "user"
  return (
    <>
      <View style={styles.bar}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text
          numberOfLines={1}
          style={[styles.status, { color: state === "waiting" ? theme.attention : theme.text }]}
        >
          {copy(controlLabels[state])}
        </Text>
        <Button
          testID="vm-control"
          label={copy(next === "agent" ? "vm_hand_back" : "vm_take_control")}
          variant={next === "agent" ? "secondary" : "primary"}
          busy={control.busy}
          onPress={() => void control.run(() => call("vm.control", { threadId, control: next }))}
        />
      </View>
      {vm.control === "user" && vm.request !== undefined && (
        <Text selectable style={[styles.request, { color: theme.text }]}>
          {vm.request}
        </Text>
      )}
      {control.error !== null && (
        <View style={styles.padded}>
          <Notice text={control.error} tone="danger" />
        </View>
      )}
    </>
  )
}

function VmKeyboard({ screen }: { screen: RefObject<ScreenSessionHandle | null> }) {
  const theme = useTheme()
  const [ctrl, setCtrl] = useState(false)
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState("")

  const pressKey = (key: ScreenKey) => {
    screen.current?.run({ type: "key", key, ctrl })
    setCtrl(false)
  }

  const typeText = () => {
    if (text === "") return
    screen.current?.run({ type: "text", text, ctrl })
    setText("")
    setCtrl(false)
  }

  return (
    <>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        style={styles.keyScroller}
        contentContainerStyle={styles.keys}
      >
        <KeyCap
          testID="vm-type-text"
          label=""
          icon="RiKeyboardBoxLine"
          accessibilityLabel={copy("mobile_vm_type_text")}
          selected={typing}
          onPress={() => setTyping(!typing)}
        />
        <KeyCap label={copy("mobile_vm_key_ctrl")} selected={ctrl} onPress={() => setCtrl(!ctrl)} />
        {keys.map((item) => (
          <KeyCap
            key={item.key}
            label={item.label}
            icon={item.icon}
            accessibilityLabel={item.accessibilityLabel}
            onPress={() => pressKey(item.key)}
          />
        ))}
      </ScrollView>
      {typing && (
        <View style={styles.compose}>
          <TextInput
            testID="vm-text"
            value={text}
            onChangeText={setText}
            onSubmitEditing={typeText}
            placeholder={copy("mobile_vm_text_placeholder")}
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            submitBehavior="submit"
            returnKeyType="send"
            style={[styles.input, { color: theme.text, backgroundColor: theme.surface, borderColor: theme.border }]}
          />
          <Button testID="vm-text-send" label={copy("mobile_vm_send_text")} variant="primary" onPress={typeText} />
        </View>
      )}
    </>
  )
}

function KeyCap({
  testID,
  label,
  icon,
  accessibilityLabel,
  selected = false,
  onPress,
}: {
  testID?: string
  label: string
  icon?: IconName | undefined
  accessibilityLabel?: string | undefined
  selected?: boolean
  onPress: () => void
}) {
  const theme = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.keyCap,
        {
          backgroundColor: selected ? theme.text : pressed ? theme.sheetRaised : theme.surface,
          borderColor: theme.border,
        },
      ]}
    >
      {icon === undefined ? (
        <Text style={[styles.keyLabel, { color: selected ? theme.background : theme.text }]}>{label}</Text>
      ) : (
        <Icon name={icon} size={16} color={selected ? theme.background : theme.text} />
      )}
    </Pressable>
  )
}

interface ScreenSessionHandle {
  readonly run: VmScreenViewHandle["run"]
}

function ScreenSession({
  ref,
  threadId,
  user,
  fit,
  onReconnect,
}: {
  ref: Ref<ScreenSessionHandle>
  threadId: string
  user: boolean
  fit: ScreenFit
  onReconnect: () => void
}) {
  const theme = useTheme()
  const generation = useConnection((state) => state.generation)
  const view = useRef<VmScreenViewHandle>(null)
  const stream = useRef<VmScreenStream | null>(null)
  const streamGeneration = useRef(0)
  const mounted = useRef(false)
  const [ready, setReady] = useState(false)
  const [connection, setConnection] = useState<Connection>({ status: "connecting" })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      stream.current?.close()
    }
  }, [])

  const lose = (failure?: unknown) => {
    if (!mounted.current) return
    if (stream.current !== null && useConnection.getState().generation !== streamGeneration.current) {
      return onReconnect()
    }
    setConnection((current) =>
      current.status === "lost"
        ? current
        : { status: "lost", reason: failure === undefined ? null : errorText(failure) },
    )
  }

  const disconnect = () => {
    stream.current?.close()
    lose()
  }

  const reconnectIfLost = useEffectEvent((connectionGeneration: number) => {
    if (connection.status === "lost" && connectionGeneration !== streamGeneration.current) onReconnect()
  })
  useEffect(() => reconnectIfLost(generation), [generation])

  useEffect(() => {
    if (ready) view.current?.run({ type: "control", user })
  }, [ready, user])

  useEffect(() => {
    if (ready) view.current?.run({ type: "fit", fit })
  }, [ready, fit])

  const start = () => {
    const streamId = randomUUID()
    streamGeneration.current = useConnection.getState().generation
    stream.current = streamVmScreen(
      {
        open: () => call("vm.screen.open", { threadId, streamId }),
        read: (offset) => call("vm.screen.read", { streamId, offset }),
        send: (data) => call("vm.screen.send", { streamId, data }),
        close: () => call("vm.screen.close", { streamId }),
      },
      {
        onOpen: () => view.current?.run({ type: "open" }),
        onData: (data) => view.current?.run({ type: "data", data: Base64.encode(data) }),
        onEnd: (failure) => {
          view.current?.run({ type: "end" })
          lose(failure)
        },
      },
    )
  }

  const received = (message: ScreenMessage) => {
    switch (message.type) {
      case "ready":
        if (stream.current === null) start()
        return setReady(true)
      case "send": {
        const bytes = Base64.decode(message.data)
        if (Result.isSuccess(bytes)) stream.current?.send(bytes.success)
        return
      }
      case "connected":
        return setConnection({ status: "connected" })
      case "disconnected":
        return disconnect()
    }
  }

  useImperativeHandle(ref, () => ({ run: (command) => view.current?.run(command) }))

  return (
    <View style={[styles.screen, { backgroundColor: theme.surface }]}>
      <VmScreenView ref={view} onMessage={received} onGone={disconnect} />
      {connection.status !== "connected" && (
        <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: theme.surface }]}>
          {connection.status === "connecting" ? (
            <>
              <ActivityIndicator color={theme.textMuted} />
              <Text style={[styles.messageText, { color: theme.textMuted }]}>{copy("vm_connecting")}</Text>
            </>
          ) : (
            <>
              <Text style={[styles.messageText, { color: theme.text }]}>{copy("vm_disconnected")}</Text>
              {connection.reason !== null && (
                <Text selectable style={[styles.messageText, { color: theme.textMuted }]}>
                  {connection.reason}
                </Text>
              )}
              <Button testID="vm-reconnect" label={copy("vm_reconnect")} onPress={onReconnect} />
            </>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  footerSpace: { paddingBottom: 8 },
  message: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  messageText: { fontSize: 15, lineHeight: 21, textAlign: "center" },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
  status: { flex: 1, fontSize: 15, fontWeight: "600" },
  request: { paddingHorizontal: 16, paddingBottom: 8, fontSize: 15, lineHeight: 21 },
  padded: { paddingHorizontal: 16, paddingBottom: 8 },
  screen: { flex: 1, overflow: "hidden" },
  overlay: { alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  keyScroller: { flexGrow: 0 },
  keys: { gap: 6, paddingHorizontal: 16, paddingTop: 8 },
  keyCap: {
    minWidth: HIT,
    minHeight: HIT,
    paddingHorizontal: 10,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  keyLabel: { fontSize: 15, fontWeight: "500" },
  compose: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 16, paddingTop: 8 },
  input: {
    flex: 1,
    minHeight: HIT,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
  },
})
