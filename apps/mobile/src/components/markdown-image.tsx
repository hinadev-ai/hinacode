import { useEffect, useMemo, useState } from "react"
import { Image, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native"
import { SvgXml } from "react-native-svg"
import { Icon } from "@/components/icon"
import { PressableScale, Reveal } from "@/components/motion"
import { radius } from "@/constants/theme"
import { useTheme } from "@/hooks/use-theme"
import { call } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { resolveImageSource } from "@/lib/markdown-paths"

const MAX_HEIGHT = 420
const PLACEHOLDER_HEIGHT = 160
const CACHE_SIZE = 24

/** Data URLs of workspace images by `root + "\0" + path`, oldest first. */
const previews = new Map<string, string>()

function rememberPreview(key: string, dataUrl: string) {
  previews.delete(key)
  previews.set(key, dataUrl)
  const oldest = previews.keys().next().value
  if (previews.size > CACHE_SIZE && oldest !== undefined) previews.delete(oldest)
}

type Loaded = { key: string; uri: string | null }

/**
 * An image from a reply. A path loads from the thread's working folder through `fs.preview`, a URL loads directly,
 * and anything that cannot load shows its path instead of a broken frame.
 */
export function MarkdownImage({
  src,
  alt,
  root,
  folder,
}: {
  src: string
  alt: string
  root: string | null
  folder?: string
}) {
  const source = useMemo(() => resolveImageSource(src, root, folder), [src, root, folder])
  const key = source.kind === "file" ? `${source.root}\0${source.path}` : ""
  const label = source.kind === "file" ? source.path : src
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (source.kind !== "file" || previews.has(key)) return
    let live = true
    call("fs.preview", { root: source.root, path: source.path }).then(
      ({ dataUrl }) => {
        rememberPreview(key, dataUrl)
        if (live) setLoaded({ key, uri: dataUrl })
      },
      () => {
        if (live) setLoaded({ key, uri: null })
      },
    )
    return () => {
      live = false
    }
  }, [source, key])

  if (source.kind === "unavailable") return <ImageChip path={label} alt={alt} />
  if (source.kind === "uri") return <LoadedImage uri={source.uri} path={label} alt={alt} />
  const uri = previews.get(key) ?? (loaded?.key === key ? loaded.uri : undefined)
  if (uri === undefined) return <Placeholder />
  if (uri === null) return <ImageChip path={label} alt={alt} />
  return <LoadedImage uri={uri} path={label} alt={alt} />
}

function Placeholder() {
  const theme = useTheme()
  return <Reveal style={[styles.placeholder, { backgroundColor: theme.surface }]}>{null}</Reveal>
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

/** Width over height from an SVG's viewBox, or its width and height attributes. */
function svgRatio(xml: string): number {
  const viewBox = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(xml)
  const width = Number(viewBox?.[1] ?? /\swidth\s*=\s*["']([\d.]+)/i.exec(xml)?.[1])
  const height = Number(viewBox?.[2] ?? /\sheight\s*=\s*["']([\d.]+)/i.exec(xml)?.[1])
  return width > 0 && height > 0 ? width / height : 1
}

type Size = { uri: string; ratio: number } | { uri: string; failed: true }

function LoadedImage({ uri, path, alt }: { uri: string; path: string; alt: string }) {
  // Native Image cannot draw SVG; the web's <img> can.
  const svg = useMemo(() => (Platform.OS === "web" ? null : svgMarkup(uri)), [uri])
  const [size, setSize] = useState<Size | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (svg !== null) return
    let live = true
    Image.getSize(
      uri,
      (width, height) => {
        if (live) setSize(width > 0 && height > 0 ? { uri, ratio: width / height } : { uri, failed: true })
      },
      () => {
        if (live) setSize({ uri, failed: true })
      },
    )
    return () => {
      live = false
    }
  }, [uri, svg])

  const ratio = svg !== null ? svgRatio(svg) : size?.uri === uri && "ratio" in size ? size.ratio : undefined
  if (failed === uri || (size?.uri === uri && "failed" in size)) return <ImageChip path={path} alt={alt} />
  if (ratio === undefined) return <Placeholder />

  const picture =
    svg !== null ? (
      <SvgXml xml={svg} width="100%" height="100%" fallback={<ImageChip path={path} alt={alt} />} />
    ) : (
      <Image
        source={{ uri }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
        onError={() => setFailed(uri)}
        style={styles.fill}
      />
    )

  return (
    <>
      <PressableScale
        accessibilityRole="imagebutton"
        accessibilityLabel={copy("mobile_image_open", { path: alt !== "" ? alt : path })}
        onPress={() => setOpen(true)}
        style={[styles.frame, { aspectRatio: ratio }]}
      >
        {picture}
      </PressableScale>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy("mobile_image_close")}
          onPress={() => setOpen(false)}
          style={styles.backdrop}
        >
          {picture}
        </Pressable>
      </Modal>
    </>
  )
}

function ImageChip({ path, alt }: { path: string; alt: string }) {
  const theme = useTheme()
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={copy("mobile_image_unavailable", { path })}
      style={[styles.chip, { backgroundColor: theme.surface, borderColor: theme.border }]}
    >
      <Icon name="RiImageLine" size={14} color={theme.textMuted} />
      <Text numberOfLines={2} style={[styles.chipText, { color: theme.textMuted }]}>
        {alt !== "" && alt !== path ? `${alt} (${path})` : path}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  placeholder: { width: "100%", height: PLACEHOLDER_HEIGHT, borderRadius: radius.md },
  frame: { width: "100%", maxHeight: MAX_HEIGHT, borderRadius: radius.md, overflow: "hidden" },
  fill: { width: "100%", height: "100%" },
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.92)", padding: 16 },
  chip: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: "100%",
  },
  chipText: { flexShrink: 1, fontSize: 13 },
})
