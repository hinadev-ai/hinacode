import { useAtomValue } from "@effect/atom-react"
import { useState } from "react"
import { Image, Platform } from "react-native"
import { SvgXml } from "react-native-svg"
import { Effect, Option } from "effect"
import { Atom, AsyncResult } from "effect/reactivity"
import { Icon } from "@/components/icon"
import { useTheme } from "@/hooks/use-theme"
import { request, type RpcError } from "@/lib/connection"
import { beforeFirstHandshake, familyOf } from "@/lib/remote"

/** Favicon data URLs by project id, null when the project has none. Every row of a project shares one read. */
const projectIcon = familyOf((projectId: string) =>
  Atom.make((get) => {
    const shown = get.self<AsyncResult.AsyncResult<string | null, RpcError>>().pipe(Option.filter(AsyncResult.isSuccess))
    if (Option.isSome(shown)) return Effect.succeed(shown.value.value)
    if (beforeFirstHandshake(get)) return Effect.never
    return request("projects.icon", { id: projectId })
  }).pipe(Atom.keepAlive),
)

const useProjectIcon = (projectId: string): string | null =>
  AsyncResult.getOrElse(useAtomValue(projectIcon(projectId)), () => null)

/** The project's own favicon, or a folder when it has none, as on the desktop. */
export function ProjectIcon({ projectId, size }: { projectId: string; size: number }) {
  const theme = useTheme()
  const icon = useProjectIcon(projectId)
  const [failed, setFailed] = useState<string | null>(null)
  if (icon === null || failed === icon) return <Icon name="Folder" size={size} color={theme.textMuted} />
  // Native Image cannot draw SVG; the web's <img> can.
  const svg = Platform.OS === "web" ? null : svgMarkup(icon)
  if (svg !== null) return <SvgXml xml={svg} width={size} height={size} />
  return (
    <Image
      source={{ uri: icon }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      onError={() => setFailed(icon)}
      style={{ width: size, height: size, flexShrink: 0 }}
    />
  )
}

const SVG_PREFIX = /^data:image\/svg\+xml(;[^,]*)?,/i

/** The markup of an SVG data URL, or null for any other image. */
function svgMarkup(uri: string): string | null {
  const match = SVG_PREFIX.exec(uri)
  if (match === null) return null
  const body = uri.slice(match[0].length)
  try {
    const xml = /;base64/i.test(match[1] ?? "")
      ? decodeURIComponent(atob(body).replace(/[\s\S]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`))
      : decodeURIComponent(body)
    return xml.includes("<svg") ? xml : null
  } catch {
    return null
  }
}
