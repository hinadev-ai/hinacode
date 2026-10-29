import type { DiffsHighlighter } from "@pierre/diffs"
import { Suspense, use } from "react"
import { useTheme } from "../lib/appearance.ts"
import { useClientSettings } from "../lib/settings.ts"
import { FindPartContext, Highlighted, highlightRuns, type Run, useFindPattern } from "./FindHighlight.tsx"

interface Loaded {
  readonly highlighter: DiffsHighlighter
  readonly theme: string
}

const highlighters = new Map<string, Promise<Loaded | null>>()

const highlighterFor = (theme: string | undefined, scheme: "dark" | "light", language: string) => {
  const key = `${theme ?? scheme}\0${language}`
  let loaded = highlighters.get(key)
  if (loaded === undefined) {
    loaded = import("@pierre/diffs")
      .then(async ({ DEFAULT_THEMES, getSharedHighlighter }) => {
        const name = theme ?? DEFAULT_THEMES[scheme]
        return { highlighter: await getSharedHighlighter({ themes: [name], langs: [language] }), theme: name }
      })
      .catch(() => null)
    highlighters.set(key, loaded)
  }
  return loaded
}

export function HighlightedCode({ code, language }: { code: string; language: string | undefined }) {
  const { codeTheme, scheme } = useTheme(useClientSettings().appearance.theme)
  if (language === undefined || language === "") return <Highlighted text={code} />
  return (
    <Suspense fallback={<Highlighted text={code} />}>
      <Tokens code={code} language={language.toLowerCase()} theme={codeTheme} scheme={scheme} />
    </Suspense>
  )
}

interface TokensProps {
  readonly code: string
  readonly language: string
  readonly theme: string | undefined
  readonly scheme: "dark" | "light"
}

function Tokens({ code, language, theme, scheme }: TokensProps) {
  const loaded = use(highlighterFor(theme, scheme, language))
  if (loaded === null) return <Highlighted text={code} />
  const { tokens } = loaded.highlighter.codeToTokens(code, { lang: language, theme: loaded.theme })
  const runs = tokens.flatMap((line, index): Array<Run> => [
    ...(index === 0 ? [] : [{ text: "\n" }]),
    ...line.map((token) => ({ text: token.content, color: token.color })),
  ])
  return <HighlightedRuns runs={runs} />
}

function HighlightedRuns({ runs }: { runs: ReadonlyArray<Run> }) {
  return highlightRuns(runs, useFindPattern(), use(FindPartContext))
}
