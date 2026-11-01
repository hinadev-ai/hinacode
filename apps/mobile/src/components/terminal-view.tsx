import { useImperativeHandle, useRef, useState } from "react"
import { WebView } from "react-native-webview"
import { type TerminalViewProps, xtermTheme } from "./terminal-types"
import { useScheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"
import { TERMINAL_HTML } from "@/terminal/terminal-page"

type PageMessage =
  | { type: "input"; data: string }
  | { type: "size"; cols: number; rows: number }
  | { type: "cursorMode"; applicationCursor: boolean }

export function TerminalView({ ref, theme, onInput, onSize, onCursorMode, onBlank }: TerminalViewProps) {
  const webview = useRef<WebView>(null)
  const scheme = useScheme()
  const [page, setPage] = useState(0)
  useImperativeHandle(ref, () => ({
    write: (data) => webview.current?.injectJavaScript(`window.kkWrite(${JSON.stringify(data)});true;`),
  }))
  return (
    <WebView
      key={page}
      ref={webview}
      testID="terminal"
      accessibilityLabel={copy("mobile_terminal_label")}
      originWhitelist={["*"]}
      source={{ html: TERMINAL_HTML }}
      injectedJavaScriptBeforeContentLoaded={`window.kkTheme=${JSON.stringify(xtermTheme(theme, scheme))};true;`}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      bounces={false}
      style={{ flex: 1, backgroundColor: theme.background }}
      onRenderProcessGone={() => {
        onBlank()
        setPage(page + 1)
      }}
      onMessage={(event) => {
        const message = JSON.parse(event.nativeEvent.data) as PageMessage
        if (message.type === "input") onInput(message.data)
        else if (message.type === "size") onSize(message.cols, message.rows)
        else onCursorMode(message.applicationCursor)
      }}
    />
  )
}
