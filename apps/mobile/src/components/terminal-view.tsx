import { useImperativeHandle, useRef } from "react"
import { WebView } from "react-native-webview"
import { type TerminalViewProps, xtermTheme } from "./terminal-types"
import { TERMINAL_HTML } from "@/terminal/terminal-page"

type PageMessage = { type: "input"; data: string } | { type: "size"; cols: number; rows: number }

export function TerminalView({ ref, theme, onInput, onSize }: TerminalViewProps) {
  const webview = useRef<WebView>(null)
  useImperativeHandle(ref, () => ({
    write: (data) => webview.current?.injectJavaScript(`window.kkWrite(${JSON.stringify(data)});true;`),
  }))
  return (
    <WebView
      ref={webview}
      testID="terminal"
      accessibilityLabel="Terminal"
      originWhitelist={["*"]}
      source={{ html: TERMINAL_HTML }}
      injectedJavaScriptBeforeContentLoaded={`window.kkTheme=${JSON.stringify(xtermTheme(theme))};true;`}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      bounces={false}
      style={{ flex: 1, backgroundColor: theme.background }}
      onMessage={(event) => {
        const message = JSON.parse(event.nativeEvent.data) as PageMessage
        if (message.type === "input") onInput(message.data)
        else onSize(message.cols, message.rows)
      }}
    />
  )
}
