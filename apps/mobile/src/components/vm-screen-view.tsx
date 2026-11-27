import { type Ref, useImperativeHandle, useRef } from "react"
import { WebView } from "react-native-webview"
import { copy } from "@/lib/copy"
import type { ScreenCommand, ScreenMessage } from "@/vm-screen/controller"
import { VM_SCREEN_HTML } from "@/vm-screen/vm-screen-page"

export interface VmScreenViewHandle {
  readonly run: (command: ScreenCommand) => void
}

export interface VmScreenViewProps {
  readonly ref: Ref<VmScreenViewHandle>
  readonly onMessage: (message: ScreenMessage) => void
  readonly onGone: () => void
}

export function VmScreenView({ ref, onMessage, onGone }: VmScreenViewProps) {
  const webview = useRef<WebView>(null)
  useImperativeHandle(ref, () => ({
    run: (command) => webview.current?.injectJavaScript(`window.kkScreen(${JSON.stringify(command)});true;`),
  }))
  return (
    <WebView
      ref={webview}
      testID="vm-screen"
      accessibilityLabel={copy("vm_screen")}
      originWhitelist={["*"]}
      source={{ html: VM_SCREEN_HTML }}
      bounces={false}
      scrollEnabled={false}
      hideKeyboardAccessoryView
      style={{ flex: 1, backgroundColor: "transparent" }}
      onRenderProcessGone={onGone}
      onContentProcessDidTerminate={onGone}
      onMessage={(event) => onMessage(JSON.parse(event.nativeEvent.data) as ScreenMessage)}
    />
  )
}
