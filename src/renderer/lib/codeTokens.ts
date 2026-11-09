import type { HighlighterCore } from "shiki/core"
import type { Run } from "../components/FindHighlight.tsx"

export interface Loaded {
  readonly highlighter: Pick<HighlighterCore, "codeToTokens">
  readonly theme: string
}

const highlighters = new Map<string, Promise<Loaded | null>>()

export const highlighterFor = (theme: string | undefined, scheme: "dark" | "light", language: string) => {
  const key = `${theme ?? scheme}\0${language}`
  let loaded = highlighters.get(key)
  if (loaded === undefined) {
    loaded = import("./codeThemes.ts")
      .then(() => import("@pierre/diffs"))
      .then(async ({ DEFAULT_THEMES, getSharedHighlighter }) => {
        const name = theme ?? DEFAULT_THEMES[scheme]
        return { highlighter: await getSharedHighlighter({ themes: [name], langs: [language] }), theme: name }
      })
      .catch(() => null)
    highlighters.set(key, loaded)
  }
  return loaded
}

export function codeRuns(loaded: Loaded, code: string, language: string): Array<Run> {
  const { tokens } = loaded.highlighter.codeToTokens(code, { lang: language, theme: loaded.theme })
  return tokens.flatMap((line, index): Array<Run> => [
    ...(index === 0 ? [] : [{ text: "\n" }]),
    ...line.map((token) => ({ text: token.content, color: token.color })),
  ])
}
