import type { ArtifactStore } from "./store.ts"

export const ARTIFACT_HEADERS = {
  "content-security-policy": "sandbox allow-scripts",
  "access-control-allow-origin": "null",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })

const decodePath = (segments: string[]) => {
  try {
    return segments.map(decodeURIComponent).join("/")
  } catch {
    return null
  }
}

export const handleArtifactRequest = async (store: ArtifactStore, request: Request): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 })
  const [, id = "", ...segments] = new URL(request.url).pathname.split("/")
  const path = decodePath(segments)
  const artifact = await store.get(id)
  if (path === null || !artifact) return notFound()
  const file = await store.file(id, path === "" ? artifact.entry : path)
  if (!file) return notFound()
  return new Response(request.method === "HEAD" ? null : file.bytes, {
    headers: { "content-type": file.type, ...ARTIFACT_HEADERS },
  })
}
