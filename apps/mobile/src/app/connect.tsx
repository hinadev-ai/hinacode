import { CameraView, useCameraPermissions } from "expo-camera"
import { useState } from "react"
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"
import { parsePairingUrl } from "@shared/remote.ts"
import { pair } from "@/components/connection-provider"
import { Button, Notice } from "@/components/ui"
import { mono } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"

export default function ConnectScreen() {
  const theme = useTheme()
  const refused = useConnection((state) => state.error)
  const [text, setText] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [scanning, setScanning] = useState(false)

  const submit = async (value: string) => {
    const target = parsePairingUrl(value)
    setInvalid(target === null)
    if (target === null) return false
    // The protected stack swaps this screen for the thread list once the pairing is stored.
    await pair(target)
    return true
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={[styles.lead, { color: theme.textMuted }]}>
        On the desktop, open Settings, Remote, and turn on Allow remote control. Scan the QR code it shows, or paste
        the pairing URL.
      </Text>
      {refused !== null && <Notice text={refused} tone="danger" />}
      <View style={styles.field}>
        <Text nativeID="pairing-url-label" style={[styles.label, { color: theme.text }]}>
          Pairing URL
        </Text>
        <TextInput
          testID="pairing-url-input"
          accessibilityLabel="Pairing URL"
          accessibilityLabelledBy="pairing-url-label"
          value={text}
          onChangeText={(value) => {
            setText(value)
            setInvalid(false)
          }}
          placeholder="kkcode://connect?host=...&port=...&token=..."
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
            This is not a kkcode pairing URL. Copy it again from Settings, Remote.
          </Text>
        )}
      </View>
      <Button testID="connect-button" label="Connect" variant="primary" onPress={() => void submit(text)} />
      {Platform.OS !== "web" && <Button testID="scan-qr-button" label="Scan QR code" onPress={() => setScanning(true)} />}
      {scanning && <Scanner onClose={() => setScanning(false)} onScan={submit} />}
    </ScrollView>
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
            <Text style={{ color: theme.text, fontSize: 16 }}>
              kkcode needs the camera to read the pairing QR code.
            </Text>
            <Button label="Allow camera" variant="primary" onPress={() => void requestPermission()} />
          </View>
        )}
        <Button label="Cancel" onPress={onClose} style={styles.cancel} />
      </SafeAreaView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  lead: { fontSize: 15, lineHeight: 22 },
  field: { gap: 8 },
  label: { fontSize: 14, fontWeight: "600" },
  input: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontFamily: mono,
    fontSize: 13,
    textAlignVertical: "top",
  },
  scanner: { flex: 1 },
  camera: { flex: 1 },
  permission: { flex: 1, padding: 20, gap: 16, justifyContent: "center" },
  cancel: { margin: 20 },
})
