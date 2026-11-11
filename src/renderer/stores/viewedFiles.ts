import { create } from "zustand"

const VIEWED_FILES_KEY = "hinacode.viewedPullRequestFiles"
const VIEWED_PULL_REQUESTS_KEPT = 200

type ViewedFiles = Readonly<Record<string, { readonly head: string; readonly paths: ReadonlyArray<string> }>>

const loadViewedFiles = (): ViewedFiles => {
  try {
    return JSON.parse(localStorage.getItem(VIEWED_FILES_KEY) ?? "{}") as ViewedFiles
  } catch {
    return {}
  }
}

export const useViewedFiles = create<{
  readonly byUrl: ViewedFiles
  readonly setViewed: (url: string, head: string, path: string, viewed: boolean) => void
}>()((set) => ({
  byUrl: loadViewedFiles(),
  setViewed: (url, head, path, viewed) => {
    const { [url]: current, ...others } = loadViewedFiles()
    const paths = (current?.head === head ? current.paths : []).filter((other) => other !== path)
    const byUrl = Object.fromEntries([
      ...Object.entries(others).slice(1 - VIEWED_PULL_REQUESTS_KEPT),
      [url, { head, paths: viewed ? [...paths, path] : paths }],
    ])
    localStorage.setItem(VIEWED_FILES_KEY, JSON.stringify(byUrl))
    set({ byUrl })
  },
}))

const NONE_VIEWED: ReadonlyArray<string> = []

export const useViewedPaths = (url: string, head: string) =>
  useViewedFiles((state) => {
    const entry = state.byUrl[url]
    return entry?.head === head ? entry.paths : NONE_VIEWED
  })
