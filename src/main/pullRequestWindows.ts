import { parseGitHubPullRequestUrl } from "../shared/github.ts"

interface ReviewWindow {
  isDestroyed(): boolean
  on(event: "closed", listener: () => void): unknown
}

export const pullRequestWindows = <W extends ReviewWindow>({
  open,
  focus,
}: {
  open: (threadId: string, url: string) => W
  focus: (window: W) => void
}) => {
  const windows = new Map<string, W>()
  return (threadId: string, raw: string) => {
    const url = parseGitHubPullRequestUrl(raw)
    if (url === undefined) return
    const key = JSON.stringify([threadId, url])
    const existing = windows.get(key)
    if (existing && !existing.isDestroyed()) {
      focus(existing)
      return
    }
    const window = open(threadId, url)
    windows.set(key, window)
    window.on("closed", () => windows.delete(key))
  }
}
