import { StyleSheet } from "react-native"
import { WebView } from "react-native-webview"
import { copy } from "@/lib/copy"
import type { DesktopStreamProps } from "./desktop-stream.types"

export function DesktopStream({ url, onLoad, onFail }: DesktopStreamProps) {
  return (
    <WebView
      testID="vm-desktop"
      accessibilityLabel={copy("mobile_vm_screen")}
      source={{ uri: url }}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      bounces={false}
      style={styles.stream}
      onLoadEnd={onLoad}
      onError={onFail}
      onHttpError={onFail}
      onRenderProcessGone={onFail}
      onContentProcessDidTerminate={onFail}
    />
  )
}

const styles = StyleSheet.create({ stream: { flex: 1, backgroundColor: "#000" } })
