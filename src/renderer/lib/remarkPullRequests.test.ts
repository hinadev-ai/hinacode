import { describe, expect, test } from "@effect/vitest"
import { remarkPullRequests } from "./remarkPullRequests.ts"

const repository = { owner: "o", name: "r" }
const text = (value: string) => ({ type: "text", value })

describe("remarkPullRequests", () => {
  test("marks #n in text, but not in code or inside an existing link", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            text("fixed by #3"),
            { type: "inlineCode", value: "#4" },
            { type: "link", url: "https://x.dev", children: [text("#5")] },
          ],
        },
        { type: "code", value: "#6" },
      ],
    }
    remarkPullRequests(repository)()(tree)
    expect(tree.children).toStrictEqual([
      {
        type: "paragraph",
        children: [
          text("fixed by "),
          {
            type: "pullRequestReference",
            data: { hName: "span", hProperties: { dataPullRequest: "https://github.com/o/r/pull/3" } },
            children: [text("#3")],
          },
          { type: "inlineCode", value: "#4" },
          { type: "link", url: "https://x.dev", children: [text("#5")] },
        ],
      },
      { type: "code", value: "#6" },
    ])
  })
})
