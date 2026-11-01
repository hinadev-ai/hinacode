import { CameraView, useCameraPermissions } from "expo-camera"
import { useHeaderHeight } from "expo-router/react-navigation"
import { type ReactNode, useState } from "react"
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { parsePairingUrl } from "@shared/remote.ts"
import { pair } from "@/components/connection-provider"
import { Icon } from "@/components/icon"
import { Button, Notice } from "@/components/ui"
import { mono, radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

/**
 * Scan or paste a pairing URL. The first pairing needs no `onPaired`: the protected stack swaps this screen for
 * the thread list once a server is stored. `footer` goes below the form, inside its scroll view.
 */
export function PairingForm({
  refused = null,
  onPaired,
  footer,
}: {
  refused?: string | null
  onPaired?: () => void
  footer?: ReactNode
}) {
  const theme = useTheme()
  const [text, setText] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [scanning, setScanning] = useState(false)

  const submit = async (value: string) => {
    const target = parsePairingUrl(value)
    setInvalid(target === null)
    if (target === null) return false
    pair(target)
    onPaired?.()
    return true
  }

  const native = Platform.OS !== "web"
  const headerHeight = useHeaderHeight()

  const form = (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.container}
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
      keyboardShouldPersistTaps="handled"
    >
      <View style={[styles.mark, { backgroundColor: theme.primary }]}>
        <Icon name="RiSmartphoneLine" size={28} color={theme.onPrimary} />
      </View>
      <Text style={[styles.lead, { color: theme.textMuted }]}>
        {copy("mobile_pairing_lead")}
      </Text>
      {refused !== null && <Notice text={refused} tone="danger" />}
      {native && (
        <Button
          testID="scan-qr-button"
          label={copy("mobile_pairing_scan")}
          icon="RiQrScanLine"
          variant="primary"
          onPress={() => setScanning(true)}
        />
      )}
      <View style={styles.field}>
        <Text nativeID="pairing-url-label" style={[styles.label, { color: theme.text }]}>
          {copy("mobile_pairing_url")}
        </Text>
        <TextInput
          testID="pairing-url-input"
          accessibilityLabel={copy("mobile_pairing_url")}
          accessibilityLabelledBy="pairing-url-label"
          value={text}
          onChangeText={(value) => {
            setText(value)
            setInvalid(false)
          }}
          placeholder="hinacode://connect?host=...&port=...&token=..."
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.surface, borderColor: invalid ? theme.danger : theme.border },
          ]}
        />
        {invalid && (
          <Text accessibilityRole="alert" style={{ color: theme.danger }}>
            {copy("mobile_pairing_invalid")}
          </Text>
        )}
      </View>
      <Button
        testID="connect-button"
        label={copy("mobile_pairing_connect")}
        variant={native ? "secondary" : "primary"}
        onPress={() => void submit(text)}
      />
      {footer}
      {scanning && <Scanner onClose={() => setScanning(false)} onScan={submit} />}
    </ScrollView>
  )

  if (Platform.OS === "ios") return form

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      {form}
    </KeyboardAvoidingView>
  )
}

function Scanner({ onClose, onScan }: { onClose: () => void; onScan: (data: string) => Promise<boolean> }) {
  const theme = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [handled, setHandled] = useState(false)

  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={[styles.scanner, { backgroundColor: theme.background }]}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={
              handled
                ? undefined
                : ({ data }) => {
                    setHandled(true)
                    void onScan(data).then((paired) => (paired ? onClose() : setHandled(false)))
                  }
            }
          />
        ) : (
          <View style={styles.permission}>
            <Icon name="RiCameraLine" size={28} color={theme.textMuted} />
            <Text style={{ color: theme.text, fontSize: 16, textAlign: "center" }}>
              {copy("mobile_pairing_camera_needed")}
            </Text>
            <Button label={copy("mobile_pairing_allow_camera")} variant="primary" onPress={() => void requestPermission()} />
          </View>
        )}
        <Button label={copy("mobile_pairing_cancel")} icon="RiCloseLine" onPress={onClose} style={styles.cancel} />
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { padding: 20, gap: 16 },
  mark: {
    width: 56,
    height: 56,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
  },
  lead: { fontSize: 15, lineHeight: 22 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600" },
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: 12,
    fontFamily: mono,
    fontSize: 13,
    textAlignVertical: "top",
  },
  scanner: { flex: 1 },
  camera: { flex: 1 },
  permission: { flex: 1, padding: 20, gap: 16, alignItems: "center", justifyContent: "center" },
  cancel: { margin: 20 },
})
