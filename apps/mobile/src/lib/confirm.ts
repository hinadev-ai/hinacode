import { Alert, Platform } from "react-native"
import { copy } from "@/lib/copy"

// react-native-web's Alert shows no buttons, so the browser's own confirm stands in.
export function confirmDestructive(title: string, message: string, action: string, onConfirm: () => void) {
  if (Platform.OS === "web") {
    if (window.confirm(`${title}\n\n${message}`)) onConfirm()
    return
  }
  Alert.alert(title, message, [
    { text: copy("mobile_settings_cancel"), style: "cancel" },
    { text: action, style: "destructive", onPress: onConfirm },
  ])
}
