import type { DiffsThemeNames, SupportedLanguages } from "@pierre/diffs"
import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import type { Run } from "../components/FindHighlight.tsx"
import type { CodeTokensRequest, CodeTokensResponse } from "./codeTokens.worker.ts"
import { familyOf } from "./rpc.ts"

type Runs = ReadonlyArray<Run> | null

const pending = new Map<number, (runs: Runs) => void>()
const sentToWorker = new Set<string>()
let nextId = 0
let worker: Worker | null | undefined

const tokenWorker = () => {
  if (worker !== undefined) return worker
  worker = new Worker(new URL("./codeTokens.worker.ts", import.meta.url), { type: "module" })
  worker.addEventListener("message", ({ data }: MessageEvent<CodeTokensResponse>) => {
    pending.get(data.id)?.(data.runs)
    pending.delete(data.id)
  })
  worker.addEventListener("error", () => {
    worker = null
    for (const resolve of pending.values()) resolve(null)
    pending.clear()
  })
  return worker
}

const firstSend = <A>(key: string, value: A) => {
  if (sentToWorker.has(key)) return undefined
  sentToWorker.add(key)
  return value
}

const tokenize = async (code: string, language: string, theme: string | undefined, scheme: "dark" | "light") => {
  const target = tokenWorker()
  if (target === null) return null
  await import("./codeThemes.ts")
  const diffs = await import("@pierre/diffs")
  const themeName = theme ?? diffs.DEFAULT_THEMES[scheme]
  const [resolvedLanguage, resolvedTheme] = await Promise.all([
    diffs.getResolvedOrResolveLanguage(language as Exclude<SupportedLanguages, "text" | "ansi">),
    diffs.getResolvedOrResolveTheme(themeName as DiffsThemeNames),
  ])
  const request: Omit<CodeTokensRequest, "id"> = {
    code,
    language,
    theme: themeName,
    resolvedLanguage: firstSend(`language\0${resolvedLanguage.name}`, resolvedLanguage),
    resolvedTheme: firstSend(`theme\0${themeName}`, resolvedTheme),
  }
  return new Promise<Runs>((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    target.postMessage({ id, ...request } satisfies CodeTokensRequest)
  })
}

export const codeTokensAtom = familyOf(
  (code: string, language: string, theme: string | undefined, scheme: "dark" | "light") =>
    Atom.make(Effect.promise(() => tokenize(code, language, theme, scheme).catch(() => null))),
)
