const ERR_NAME_NOT_RESOLVED = -105

type Shimmed = HTMLElement & { __frame?: HTMLIFrameElement }

const emit = (view: HTMLElement, type: string, fields: object = {}) =>
  view.dispatchEvent(Object.assign(new Event(type), fields))

const unresolvable = (url: string) => URL.parse(url)?.hostname.endsWith(".invalid") ?? true

const load = (view: Shimmed, url: string) => {
  const frame = view.__frame!
  emit(view, "did-start-loading")
  if (unresolvable(url)) {
    frame.removeAttribute("src")
    emit(view, "did-fail-load", {
      errorCode: ERR_NAME_NOT_RESOLVED,
      errorDescription: "ERR_NAME_NOT_RESOLVED",
      validatedURL: url,
      isMainFrame: true,
    })
    emit(view, "did-stop-loading")
    return
  }
  frame.addEventListener(
    "load",
    () => {
      emit(view, "did-navigate", { url, isMainFrame: true })
      const title = frame.contentDocument?.title
      if (title) emit(view, "page-title-updated", { title })
      emit(view, "did-stop-loading")
    },
    { once: true },
  )
  frame.src = url
}

const shim = (view: Shimmed) => {
  if (view.__frame) return
  const frame = document.createElement("iframe")
  frame.title = view.title
  frame.style.cssText = "flex: 1; width: 100%; height: 100%; border: 0; background: white"
  view.__frame = frame
  view.append(frame)
  Object.assign(view, {
    loadURL: async (url: string) => load(view, url),
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => undefined,
    goForward: () => undefined,
    reload: () => load(view, view.getAttribute("src") ?? ""),
    stop: () => undefined,
    executeJavaScript: async () => null,
  })
  queueMicrotask(() => load(view, view.getAttribute("src") ?? ""))
}

export const installWebviewShim = () => {
  new MutationObserver(() => {
    for (const view of document.querySelectorAll<Shimmed>("webview")) shim(view)
  }).observe(document.documentElement, { childList: true, subtree: true })
}
