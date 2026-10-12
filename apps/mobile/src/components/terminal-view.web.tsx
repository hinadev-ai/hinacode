import "@xterm/xterm/css/xterm.css"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import { useEffect, useEffectEvent, useImperativeHandle, useRef } from "react"
import { View } from "react-native"
import { type TerminalViewProps, xtermTheme } from "./terminal-types"

export function TerminalView({ ref, theme, onInput, onSize }: TerminalViewProps) {
  const container = useRef<View>(null)
  const terminal = useRef<Terminal | null>(null)
  const input = useEffectEvent(onInput)
  const sized = useEffectEvent(onSize)
  const initialTheme = useEffectEvent(() => xtermTheme(theme))

  useImperativeHandle(ref, () => ({ write: (data) => terminal.current?.write(data) }))

  useEffect(() => {
    // On web a View renders a div.
    const element = container.current as unknown as HTMLElement
    const term = new Terminal({
      fontSize: 13,
      fontFamily: "ui-monospace, Menlo, monospace",
      cursorBlink: true,
      scrollback: 5000,
      theme: initialTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    terminal.current = term
    let size = ""
    const resize = () => {
      fit.fit()
      if (!(term.cols > 0 && term.rows > 0) || size === `${term.cols}x${term.rows}`) return
      size = `${term.cols}x${term.rows}`
      sized(term.cols, term.rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    const subscription = term.onData((data) => input(data))
    return () => {
      observer.disconnect()
      subscription.dispose()
      term.dispose()
      terminal.current = null
    }
  }, [])

  useEffect(() => {
    if (terminal.current) terminal.current.options.theme = xtermTheme(theme)
  }, [theme])

  return (
    <View
      ref={container}
      testID="terminal"
      accessibilityLabel="Terminal"
      style={{ flex: 1, padding: 6, backgroundColor: theme.background }}
    />
  )
}
