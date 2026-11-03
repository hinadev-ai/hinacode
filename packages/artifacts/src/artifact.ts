import { extname } from "node:path"
import { z } from "zod"

export const ArtifactFileSchema = z.object({
  path: z.string(),
  type: z.string(),
  size: z.number().int().nonnegative(),
})

export const ArtifactSchema = z.object({
  id: z.string(),
  title: z.string(),
  entry: z.string(),
  version: z.number().int().positive(),
  files: z.array(ArtifactFileSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  threadId: z.string().optional(),
})

export type ArtifactFile = z.infer<typeof ArtifactFileSchema>
export type Artifact = z.infer<typeof ArtifactSchema>

export const isArtifactId = (id: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)

export const normalizeArtifactPath = (path: string): string | null => {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return null
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "") return null
    if (segment === ".") continue
    if (segment === "..") {
      if (segments.pop() === undefined) return null
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join("/")
}

const textTypes: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
}

const binaryTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
}

export const contentType = (path: string) => {
  const extension = extname(path).toLowerCase()
  const text = textTypes[extension]
  if (text) return `${text}; charset=utf-8`
  return binaryTypes[extension] ?? "application/octet-stream"
}

export const isTextType = (type: string) => type.endsWith("; charset=utf-8")
