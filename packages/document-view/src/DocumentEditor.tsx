import { requireNativeView } from "expo"
import { type Ref, useEffect, useEffectEvent, useImperativeHandle, useRef, useState } from "react"
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from "react-native"
import { linkHref } from "../../../src/shared/documentLink.ts"
import { isDocumentImagePath } from "../../../src/shared/document/schema.ts"
import type { BlockPatch } from "./blocks.ts"
import { runAction, type SelectionState } from "./actions.ts"
import { drawDiagram } from "./diagram.ts"
import { decodeNativeEvent, type NativeDocumentEvent } from "./events.ts"
import { installHtmlParser, mayHoldHtml } from "./html.ts"
import { NATIVE_VIEW } from "./protocol.ts"
import { createDocumentSession } from "./session.ts"
import type { DocumentEditorHandle, DocumentEditorProps } from "./types.ts"

type NativeHandle = {
  applyPatch(patch: string): Promise<void>
  scrollToBlock(index: number): Promise<void>
  provideImage(src: string, dataUrl: string): Promise<void>
  focus(): Promise<void>
  blur(): Promise<void>
}

type NativeProps = {
  readonly ref: Ref<NativeHandle>
  readonly theme: string
  readonly editable: boolean
  readonly contentInsetTop: number
  readonly contentInsetBottom: number
  readonly style?: StyleProp<ViewStyle>
  readonly testID?: string
  readonly onDocumentEvent: (event: NativeSyntheticEvent<unknown>) => void
}

const NativeDocumentView = requireNativeView<NativeProps>(NATIVE_VIEW)

const WEB_LINK = /^https?:\/\//i

type Listeners = {
  readonly onChange?: () => void
  readonly onSelectionChange?: (selection: SelectionState) => void
}

function createBridge() {
  let handle: NativeHandle | null = null
  let listeners: Listeners = {}
  const pending: BlockPatch[] = []
  const deliver = (patch: BlockPatch) => void handle?.applyPatch(JSON.stringify(patch))
  return {
    send: (patch: BlockPatch) => (handle === null ? pending.push(patch) : deliver(patch)),
    listen: (next: Listeners) => {
      listeners = next
    },
    changed: () => listeners.onChange?.(),
    selected: (selection: SelectionState) => listeners.onSelectionChange?.(selection),
    attach: (ready: NativeHandle) => {
      handle = ready
      for (const patch of pending.splice(0)) deliver(patch)
    },
    get handle() {
      return handle
    },
  }
}

const nextTask = (run: () => void) => void setTimeout(run, 0)

export function DocumentEditor({
  ref,
  document,
  theme,
  resolveImage,
  highlightCode,
  editable = false,
  contentInset = { top: 0, bottom: 0 },
  onLinkPress,
  onContentSizeChange,
  onError,
  onReady,
  onLoaded,
  onChange,
  onSelectionChange,
  onFocus,
  onBlur,
  style,
  testID,
}: DocumentEditorProps & { readonly ref?: Ref<DocumentEditorHandle> }) {
  const native = useRef<NativeHandle>(null)
  const [bridge] = useState(createBridge)
  useEffect(() => bridge.listen({ onChange, onSelectionChange }))
  const [session] = useState(() =>
    createDocumentSession({
      send: bridge.send,
      schedule: nextTask,
      now: () => performance.now(),
      highlight: highlightCode,
      drawDiagram,
      onEdited: bridge.changed,
      onSelection: bridge.selected,
    }),
  )

  const loaded = useEffectEvent(() => {
    onLoaded?.({ blocks: session.blocks.length })
    if (session.lossy) onError?.({ kind: "lossy", message: "" })
  })
  useEffect(() => {
    let live = true
    const load = () => {
      if (live) session.load(document.markdown, loaded)
    }
    if (mayHoldHtml(document.markdown)) void installHtmlParser().then(load, load)
    else load()
    return () => {
      live = false
    }
  }, [session, document.markdown])

  useImperativeHandle(ref, () => ({
    getMarkdown: () => (session.loaded ? session.markdown() : document.markdown),
    scrollTo: async (position) => {
      const index = session.sources.findLastIndex((source) => source.pos <= position)
      if (index === -1 || bridge.handle === null) return { ok: false, reason: "not-loaded" }
      await bridge.handle.scrollToBlock(index)
      return { ok: true }
    },
    run: async (action) => {
      if (!session.loaded) return { ok: false, reason: "not-loaded" }
      return session.run(() => runAction(session.editor, action))
        ? { ok: true }
        : { ok: false, reason: "not-applicable" }
    },
    focus: async () => {
      if (bridge.handle === null) return { ok: false, reason: "not-loaded" }
      await bridge.handle.focus()
      return { ok: true }
    },
    blur: async () => {
      if (bridge.handle === null) return { ok: false, reason: "not-loaded" }
      await bridge.handle.blur()
      return { ok: true }
    },
  }))

  const provideImage = async (src: string) => {
    const dataUrl = await resolveImage(src).catch((cause: unknown) => {
      onError?.({ kind: "image", message: `${src}: ${String(cause)}` })
      return ""
    })
    await bridge.handle?.provideImage(src, dataUrl)
  }

  const handle = (event: NativeDocumentEvent) => {
    switch (event.type) {
      case "ready":
        if (native.current !== null) bridge.attach(native.current)
        onReady?.({ capabilities: event.capabilities })
        return
      case "contentSize":
        onContentSizeChange?.({ height: event.height })
        return
      case "linkPress": {
        const href = linkHref(event.href)
        if (href !== null && WEB_LINK.test(event.href)) onLinkPress?.(href)
        return
      }
      case "imageRequest":
        if (isDocumentImagePath(event.src)) void provideImage(event.src)
        return
      case "error":
        onError?.({ kind: "unsupported", message: event.message })
        return
      case "focus":
        onFocus?.()
        return
      case "blur":
        onBlur?.()
        return
    }
    if (!editable) return
    switch (event.type) {
      case "taskToggle":
        session.toggleTask(event.block)
        return
      case "edit":
        session.edit(event)
        return
      case "select":
        session.select(event)
        return
      case "key":
        session.press(event.key, event.shift, event.eventCount)
    }
  }

  return (
    <NativeDocumentView
      ref={native}
      theme={JSON.stringify(theme)}
      editable={editable}
      contentInsetTop={contentInset.top}
      contentInsetBottom={contentInset.bottom}
      style={style}
      testID={testID}
      onDocumentEvent={({ nativeEvent }) => {
        const event = decodeNativeEvent(nativeEvent)
        if (event !== null) handle(event)
      }}
    />
  )
}
