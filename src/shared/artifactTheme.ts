import { Option, Schema } from "effect"

export const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--popover",
  "--muted",
  "--muted-foreground",
  "--border",
  "--input",
  "--ring",
  "--primary",
  "--primary-foreground",
  "--working",
  "--destructive",
  "--attention",
  "--success",
  "--graph-lane-0",
  "--graph-lane-1",
  "--graph-lane-2",
  "--graph-lane-3",
  "--graph-lane-4",
  "--graph-lane-5",
  "--radius",
] as const

const TokenValue = Schema.String.check(Schema.isPattern(/^[^;{}<>\\]{1,400}$/))

export const ArtifactTheme = Schema.Struct({
  scheme: Schema.Literals(["light", "dark"]),
  tokens: Schema.Record(Schema.Literals(THEME_TOKENS), TokenValue),
})
export type ArtifactTheme = typeof ArtifactTheme.Type

const decodeTheme = Schema.decodeUnknownOption(Schema.fromJsonString(ArtifactTheme))

export const parseArtifactTheme = (json: string | null) =>
  json === null ? undefined : Option.getOrUndefined(decodeTheme(json))

const BASE =
  ":where(html){background:var(--background);color:var(--foreground);font-family:system-ui,sans-serif;line-height:1.5}"

const themeStyle = ({ scheme, tokens }: ArtifactTheme) =>
  `:root{color-scheme:${scheme};${Object.entries(tokens)
    .map(([name, value]) => `${name}:${value};`)
    .join("")}}${BASE}`

const HEAD = /<head(?:\s[^>]*)?>/i
const DOCTYPE = /^\s*<!doctype[^>]*>/i

export const injectArtifactTheme = (html: string, theme: ArtifactTheme) => {
  const style = `<style id="hinacode-theme">${themeStyle(theme)}</style>`
  const anchor = HEAD.exec(html) ?? DOCTYPE.exec(html)
  if (anchor === null) return style + html
  const at = anchor.index + anchor[0].length
  return html.slice(0, at) + style + html.slice(at)
}

export const ARTIFACT_THEME_GUIDE = `HinaCode sets its theme on :root and paints html with --background, --foreground and a system font. Tokens: ${THEME_TOKENS.join(", ")}. --working is the brand violet, --attention a warning, and --graph-lane-1 to 5 are chart series. Color everything through these, for example --accent: var(--working) or color-mix(in oklab, var(--success) 15%, var(--background)). No literal colors and no prefers-color-scheme blocks: the app theme can differ from the OS.`
