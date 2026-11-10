const RESOURCE_PATH = "/_r/"
const PAGE_TIMEOUT_MS = 30_000

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
self.addEventListener("message", (event) => {
  if (event.data?.type === "hinacode.claim") event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(RESOURCE_PATH)) return
  event.respondWith(answer(event))
})

const pageFor = async (event) => {
  const own = event.clientId ? await self.clients.get(event.clientId) : undefined
  if (own?.frameType === "top-level") return own
  const pages = await self.clients.matchAll({ type: "window" })
  return pages.find((page) => page.frameType === "top-level")
}

const answer = async (event) => {
  const page = await pageFor(event)
  if (page === undefined) return new Response(null, { status: 503 })
  const channel = new MessageChannel()
  const reply = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: 504, headers: {}, body: null }), PAGE_TIMEOUT_MS)
    channel.port1.addEventListener("message", (message) => {
      clearTimeout(timeout)
      resolve(message.data)
    })
    channel.port1.start()
  })
  page.postMessage({ type: "hinacode.resource", url: event.request.url, destination: event.request.destination }, [
    channel.port2,
  ])
  const { status, headers, body } = await reply
  return new Response(body, { status, headers })
}
