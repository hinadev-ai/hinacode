import { useEffect, useState } from "react"
import { Image, Platform } from "react-native"
import { SvgXml } from "react-native-svg"
import { create } from "zustand"
import { Icon } from "@/components/icon"
import { svgMarkup } from "@/components/markdown-image"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"

/** Favicon data URLs by project id, null when the project has none. Every row of a project shares one read. */
const useProjectIcons = create<Readonly<Record<string, string | null>>>()(() => ({}))
const requested = new Set<string>()

function useProjectIcon(projectId: string): string | null {
  const icon = useProjectIcons((icons) => icons[projectId] ?? null)
  useEffect(() => {
    if (requested.has(projectId)) return
    requested.add(projectId)
    call("projects.icon", { id: projectId }).then(
      (found) => useProjectIcons.setState({ [projectId]: found }),
      () => requested.delete(projectId),
    )
  }, [projectId])
  return icon
}

/** The project's own favicon, or a folder when it has none, as on the desktop. */
export function ProjectIcon({ projectId, size }: { projectId: string; size: number }) {
  const theme = useTheme()
  const icon = useProjectIcon(projectId)
  const [failed, setFailed] = useState<string | null>(null)
  if (icon === null || failed === icon) return <Icon name="RiFolder3Line" size={size} color={theme.textMuted} />
  // Native Image cannot draw SVG; the web's <img> can.
  const svg = Platform.OS === "web" ? null : svgMarkup(icon)
  if (svg !== null) return <SvgXml xml={svg} width={size} height={size} />
  return (
    <Image
      source={{ uri: icon }}
      resizeMode="contain"
      accessibilityIgnoresInvertColors
      onError={() => setFailed(icon)}
      style={{ width: size, height: size }}
    />
  )
}
