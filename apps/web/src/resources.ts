import type { HinacodeBridge, RpcMethod } from "../../../src/shared/contract.ts"
import { injectProblemReporter } from "../../../src/shared/artifactProblems.ts"
import { injectArtifactTheme, parseArtifactTheme } from "../../../src/shared/artifactTheme.ts"
import { desktopResourceUrl } from "../../../src/shared/channels.ts"

const SANDBOX = { "content-security-policy": "sandbox allow-scripts" }
const ARTIFACT_HEADERS = {
  ...SANDBOX,
  "access-control-allow-origin": "null",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
}

const LINKED_FILES = [
  ["script", "src"],
  ["link", "href"],
  ["img", "src"],
  ["source", "src"],
  ["video", "src"],
  ["video", "poster"],
  ["audio", "src"],
] as const

export interface ResourceAnswer {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: ArrayBuffer | null
}

const notFound: ResourceAnswer = { status: 404, headers: {}, body: null }

const segments = (pathname: string) => {
  try {
    return pathname.slice(1).split("/").map(decodeURIComponent)
  } catch {
    return null
  }
}

const rpcFor = (desktop: URL): { method: RpcMethod; payload: object; environment?: string } | null => {
  const parts = segments(desktop.pathname)
  if (parts === null) return null
  switch (desktop.protocol) {
    case "hinacode-attachment:":
      return desktop.host === "file"
        ? {
            method: "attachments.read",
            payload: { path: parts.join("/") },
            environment: desktop.searchParams.get("environment") ?? undefined,
          }
        : null
    case "hinacode-file:": {
      const [root, ...path] = parts
      return desktop.host === "root" && root ? { method: "fs.preview", payload: { root, path: path.join("/") } } : null
    }
    case "hinacode-artifact:":
      return { method: "artifacts.file", payload: { id: desktop.host, path: parts.join("/") } }
    default:
      return null
  }
}

const dataUrlOf = async (bridge: HinacodeBridge, desktop: URL) => {
  const call = rpcFor(desktop)
  if (call === null) return null
  const envelope = await bridge.rpc(call.method, call.payload as never, call.environment)
  return "error" in envelope ? null : (envelope.result as { dataUrl: string }).dataUrl
}

const linksElsewhere = (value: string) => value === "" || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(value)

const inlineLinkedFiles = async (bridge: HinacodeBridge, desktop: URL, html: string) => {
  const page = new DOMParser().parseFromString(html, "text/html")
  await Promise.all(
    LINKED_FILES.flatMap(([tag, attribute]) =>
      [...page.querySelectorAll(`${tag}[${attribute}]`)].map(async (element) => {
        const value = element.getAttribute(attribute) ?? ""
        if (linksElsewhere(value)) return
        const dataUrl = await dataUrlOf(bridge, new URL(value, desktop))
        if (dataUrl !== null) element.setAttribute(attribute, dataUrl)
      }),
    ),
  )
  return `<!doctype html>\n${page.documentElement.outerHTML}`
}

export const resolveResource = async (
  bridge: HinacodeBridge,
  url: string,
  destination: RequestDestination,
): Promise<ResourceAnswer> => {
  const raw = desktopResourceUrl(new URL(url))
  const desktop = raw === null ? null : URL.parse(raw)
  const dataUrl = desktop === null ? null : await dataUrlOf(bridge, desktop)
  if (desktop === null || dataUrl === null) return notFound
  const file = await fetch(dataUrl)
  const type = file.headers.get("content-type") ?? "application/octet-stream"
  const framed = destination === "iframe" && type.startsWith("text/html")
  const html = framed ? await inlineLinkedFiles(bridge, desktop, await file.text()) : null
  const theme = parseArtifactTheme(desktop.searchParams.get("theme"))
  const page = html !== null && theme !== undefined ? injectArtifactTheme(injectProblemReporter(html), theme) : html
  return {
    status: 200,
    headers: {
      "content-type": type,
      ...(desktop.protocol === "hinacode-artifact:" ? ARTIFACT_HEADERS : {}),
      ...(desktop.protocol === "hinacode-file:" ? SANDBOX : {}),
    },
    body: page === null ? await file.arrayBuffer() : new TextEncoder().encode(page).buffer,
  }
}

export const serveResources = async (bridge: HinacodeBridge) => {
  navigator.serviceWorker.addEventListener(
    "message",
    (event: MessageEvent<{ type?: string; url?: string; destination?: RequestDestination }>) => {
      const [port] = event.ports
      const { type, url, destination = "" } = event.data
      if (type !== "hinacode.resource" || url === undefined || port === undefined) return
      void resolveResource(bridge, url, destination).then((answer) =>
        port.postMessage(answer, answer.body === null ? [] : [answer.body]),
      )
    },
  )
  await navigator.serviceWorker.register("/sw.js")
  await navigator.serviceWorker.ready
  if (navigator.serviceWorker.controller !== null) return
  await new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }))
}
