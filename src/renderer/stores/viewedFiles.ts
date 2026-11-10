import { create } from "zustand"

const VIEWED_FILES_KEY = "hinacode.viewedPullRequestFiles"

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
}>()((set, get) => ({
  byUrl: loadViewedFiles(),
  setViewed: (url, head, path, viewed) => {
    const current = get().byUrl[url]
    const paths = (current?.head === head ? current.paths : []).filter((other) => other !== path)
    const byUrl = { ...get().byUrl, [url]: { head, paths: viewed ? [...paths, path] : paths } }
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
