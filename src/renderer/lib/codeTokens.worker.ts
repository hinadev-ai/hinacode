import { attachResolvedLanguages, attachResolvedThemes, getSharedHighlighter } from "@pierre/diffs"
import type { ThemeRegistrationResolved } from "@pierre/diffs"
import type { ResolvedLanguage } from "@pierre/diffs/worker"
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

const highlighter = getSharedHighlighter({ themes: [], langs: [] })

const tokenize = async ({ code, language, theme, resolvedLanguage, resolvedTheme }: CodeTokensRequest) => {
  const loaded = await highlighter
  if (resolvedLanguage) attachResolvedLanguages(resolvedLanguage, loaded)
  if (resolvedTheme) attachResolvedThemes(resolvedTheme, loaded)
  return codeRuns({ highlighter: loaded, theme }, code, language)
}

self.addEventListener("message", (event: MessageEvent<CodeTokensRequest>) => {
  const { id } = event.data
  void tokenize(event.data)
    .catch(() => null)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    .then((runs) => self.postMessage({ id, runs } satisfies CodeTokensResponse))
})
