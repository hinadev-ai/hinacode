import { expect, test } from "vitest"
import { pullRequestStacks } from "./pullRequestStack.ts"

const url = (number: number, repository = "o/r") => `https://github.com/${repository}/pull/${number}`
const branches = (headRefName: string, baseRefName: string) => ({ headRefName, baseRefName })

test("nests a pull request under the one whose branch it is based on, keeping the linked order", () => {
  const stacks = pullRequestStacks(
    [url(1), url(2), url(3), url(4)],
    [branches("a", "main"), branches("b", "a"), branches("c", "a"), branches("d", "main")],
  )
  expect(stacks).toStrictEqual([
    {
      url: url(1),
      children: [
        { url: url(2), children: [] },
        { url: url(3), children: [] },
      ],
    },
    { url: url(4), children: [] },
  ])
})

test("keeps pull requests whose branches are still loading, or live in another repository, at the top", () => {
  const stacks = pullRequestStacks(
    [url(1), url(2), url(3), url(4, "o/other")],
    [branches("a", "main"), undefined, undefined, branches("c", "a")],
  )
  expect(stacks.map((stack) => stack.url)).toStrictEqual([url(1), url(2), url(3), url(4, "o/other")])
})

test("shows every pull request once when two are based on each other", () => {
  const stacks = pullRequestStacks([url(1), url(2)], [branches("a", "b"), branches("b", "a")])
  expect(stacks).toStrictEqual([{ url: url(1), children: [{ url: url(2), children: [] }] }])
})
