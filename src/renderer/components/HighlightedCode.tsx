import { DEFAULT_THEMES, type DiffsHighlighter, getSharedHighlighter } from "@pierre/diffs"
import { Suspense, use } from "react"
import { useTheme } from "../lib/appearance.ts"
import { useClientSettings } from "../lib/settings.ts"
import { FindPartContext, Highlighted, highlightRuns, type Run, useFindPattern } from "./FindHighlight.tsx"

/** Null when shiki has no grammar for the language, which then renders as plain text. */
const highlighters = new Map<string, Promise<DiffsHighlighter | null>>()

const highlighterFor = (theme: string, language: string) => {
  const key = `${theme}\0${language}`
  let highlighter = highlighters.get(key)
  if (highlighter === undefined) {
    highlighter = getSharedHighlighter({ themes: [theme], langs: [language] }).catch(() => null)
    highlighters.set(key, highlighter)
  }
  return highlighter
}

/**
 * `code` colored by the app theme's syntax colors, with the find bar's matches marked. Only colors change, never
 * font or spacing, so it can sit under a textarea. Without a known `language` it is plain text.
 */
export function HighlightedCode({ code, language }: { code: string; language: string | undefined }) {
  const { codeTheme, scheme } = useTheme(useClientSettings().appearance.theme)
  if (language === undefined || language === "") return <Highlighted text={code} />
  return (
    <Suspense fallback={<Highlighted text={code} />}>
      <Tokens code={code} language={language.toLowerCase()} theme={codeTheme ?? DEFAULT_THEMES[scheme]} />
    </Suspense>
  )
}

function Tokens({ code, language, theme }: { code: string; language: string; theme: string }) {
  const highlighter = use(highlighterFor(theme, language))
  const pattern = useFindPattern()
  const part = use(FindPartContext)
  if (highlighter === null) return <Highlighted text={code} />
  const { tokens } = highlighter.codeToTokens(code, { lang: language, theme })
  const runs = tokens.flatMap((line, index): Array<Run> => [
    ...(index === 0 ? [] : [{ text: "\n" }]),
    ...line.map((token) => ({ text: token.content, color: token.color })),
  ])
  return highlightRuns(runs, pattern, part)
}
