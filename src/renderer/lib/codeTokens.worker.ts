import type { ResolvedLanguage } from "@pierre/diffs/worker"
import { createHighlighterCore, type ThemeRegistrationResolved } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import type { Run } from "../components/FindHighlight.tsx"
import { codeRuns } from "./codeTokens.ts"

export interface CodeTokensRequest {
  readonly id: number
  readonly code: string
  readonly language: string
  readonly theme: string
  readonly resolvedLanguage?: ResolvedLanguage
  readonly resolvedTheme?: ThemeRegistrationResolved
}

export interface CodeTokensResponse {
  readonly id: number
  readonly runs: ReadonlyArray<Run> | null
}

const highlighter = createHighlighterCore({ themes: [], langs: [], engine: createJavaScriptRegexEngine() })

const tokenize = async ({ code, language, theme, resolvedLanguage, resolvedTheme }: CodeTokensRequest) => {
  const loaded = await highlighter
  if (resolvedLanguage) loaded.loadLanguageSync(resolvedLanguage.data)
  if (resolvedTheme) loaded.loadThemeSync(resolvedTheme)
  return codeRuns({ highlighter: loaded, theme }, code, language)
}

self.addEventListener("message", (event: MessageEvent<CodeTokensRequest>) => {
  const { id } = event.data
  void tokenize(event.data)
    .catch(() => null)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    .then((runs) => self.postMessage({ id, runs } satisfies CodeTokensResponse))
})
