import { expect, test } from "@effect/vitest"
import { pullRequestWindows } from "./pullRequestWindows.ts"

const PULL_REQUEST = "https://github.com/o/r/pull/1"

const fakeWindows = () => {
  const opened: Array<{ threadId: string; url: string; close: () => void }> = []
  const focused: Array<string> = []
  const openWindow = pullRequestWindows({
    open: (threadId, url) => {
      let onClosed = () => {}
      const window = {
        threadId,
        destroyed: false,
        isDestroyed: () => window.destroyed,
        on: (_event: "closed", listener: () => void) => (onClosed = listener),
      }
      opened.push({
        threadId,
        url,
        close: () => {
          window.destroyed = true
          onClosed()
        },
      })
      return window
    },
    focus: (window) => focused.push(window.threadId),
  })
  return { openWindow, opened, focused }
}

test("opening a pull request again from the same thread brings its window forward", () => {
  const { openWindow, opened, focused } = fakeWindows()
  openWindow("a", PULL_REQUEST)
  openWindow("a", PULL_REQUEST)
  expect(opened.map(({ threadId }) => threadId)).toStrictEqual(["a"])
  expect(focused).toStrictEqual(["a"])
})

test("each thread reviews the same pull request in its own window", () => {
  const { openWindow, opened, focused } = fakeWindows()
  openWindow("a", PULL_REQUEST)
  openWindow("b", PULL_REQUEST)
  expect(opened.map(({ threadId, url }) => [threadId, url])).toStrictEqual([
    ["a", PULL_REQUEST],
    ["b", PULL_REQUEST],
  ])
  expect(focused).toStrictEqual([])

  openWindow("b", PULL_REQUEST)
  expect(focused).toStrictEqual(["b"])
})

test("a closed window opens fresh the next time", () => {
  const { openWindow, opened } = fakeWindows()
  openWindow("a", PULL_REQUEST)
  opened[0]?.close()
  openWindow("a", PULL_REQUEST)
  expect(opened).toHaveLength(2)
})
