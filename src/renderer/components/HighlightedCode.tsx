import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { use } from "react"
import { useTheme } from "../lib/appearance.ts"
import { codeTokensAtom } from "../lib/offThreadTokens.ts"
import { useClientSettings } from "../lib/settings.ts"
import { FindPartContext, Highlighted, highlightRuns, useFindPattern } from "./FindHighlight.tsx"

export function HighlightedCode({ code, language }: { code: string; language: string | undefined }) {
  const { codeTheme, scheme } = useTheme(useClientSettings().appearance.theme)
  if (language === undefined || language === "") return <Highlighted text={code} />
  return <Tokens code={code} language={language.toLowerCase()} theme={codeTheme} scheme={scheme} />
}

interface TokensProps {
  readonly code: string
  readonly language: string
  readonly theme: string | undefined
  readonly scheme: "dark" | "light"
}

function Tokens({ code, language, theme, scheme }: TokensProps) {
  const runs = AsyncResult.getOrElse(useAtomValue(codeTokensAtom(code, language, theme, scheme)), () => null)
  const pattern = useFindPattern()
  const part = use(FindPartContext)
  return runs === null ? <Highlighted text={code} /> : highlightRuns(runs, pattern, part)
}
