import { describe, expect, test } from "@effect/vitest"
import { linkify } from "./linkify.ts"
import { linkPullRequestNumbers, parsePullRequestUrl, pullRequestLabel, pullRequestName } from "./pullRequestRefs.ts"

const repository = { owner: "hinadev-ai", name: "hinacode" }
const numbers = (text: string) =>
  linkPullRequestNumbers(text, repository).flatMap((segment) => (segment.type === "link" ? [segment.text] : []))

describe("linkPullRequestNumbers", () => {
  test("links #n after the start, whitespace or an opening paren", () => {
    expect(numbers("#12 fixes it, see #3 and (#45)")).toStrictEqual(["#12", "#3", "#45"])
  })

  test("needs a boundary on both sides", () => {
    expect(numbers("a#12 #12a page#12 #x #")).toStrictEqual([])
  })

  test("leaves trailing punctuation out", () => {
    expect(numbers("merged in #12.")).toStrictEqual(["#12"])
  })

  test("points at the repository's pull request and keeps every character", () => {
    const text = "see #7."
    const segments = linkPullRequestNumbers(text, repository)
    expect(segments.map((segment) => segment.text).join("")).toBe(text)
    expect(segments).toStrictEqual([
      { type: "text", text: "see " },
      { type: "link", text: "#7", href: "https://github.com/hinadev-ai/hinacode/pull/7" },
      { type: "text", text: "." },
    ])
  })
})

describe("linkify with a repository", () => {
  test("links #n outside urls, and never a url's fragment", () => {
    expect(linkify("#1 and https://example.com/page#2", repository)).toStrictEqual([
      { type: "link", text: "#1", href: "https://github.com/hinadev-ai/hinacode/pull/1" },
      { type: "text", text: " and " },
      { type: "link", text: "https://example.com/page#2", href: "https://example.com/page#2" },
    ])
  })

  test("leaves #n as text without a repository", () => {
    expect(linkify("#1")).toStrictEqual([{ type: "text", text: "#1" }])
  })
})

describe("parsePullRequestUrl", () => {
  test("reads a pull request url, with or without a trailing path or fragment", () => {
    const ref = { owner: "a-b", name: "c.d", number: 12 }
    expect(parsePullRequestUrl("https://github.com/a-b/c.d/pull/12")).toStrictEqual(ref)
    expect(parsePullRequestUrl("https://github.com/a-b/c.d/pull/12/files#diff-1")).toStrictEqual(ref)
    expect(parsePullRequestUrl("https://github.com/a-b/c.d/pull/12#issuecomment-9")).toStrictEqual(ref)
  })

  test("refuses anything else", () => {
    expect(parsePullRequestUrl("https://github.com/a/b/issues/12")).toBe(null)
    expect(parsePullRequestUrl("https://github.com/a/b/pull/12x")).toBe(null)
    expect(parsePullRequestUrl("https://evil.dev/github.com/a/b/pull/1")).toBe(null)
    expect(parsePullRequestUrl("https://github.com/a/b/pull/")).toBe(null)
  })
})

describe("pullRequestLabel", () => {
  test("is #n in the thread's own repository and owner/repo#n elsewhere", () => {
    expect(pullRequestLabel({ owner: "HINADEV-AI", name: "hinacode", number: 4 }, repository)).toBe("#4")
    expect(pullRequestLabel({ owner: "other", name: "hinacode", number: 4 }, repository)).toBe("other/hinacode#4")
    expect(pullRequestLabel({ owner: "other", name: "hinacode", number: 4 }, null)).toBe("other/hinacode#4")
  })
})

describe("pullRequestName", () => {
  test("names a pull request url as owner/repo#n", () => {
    expect(
      pullRequestName("https://github.com/northwind-industries-holdings/customer-onboarding-platform-monorepo/pull/1"),
    ).toBe("northwind-industries-holdings/customer-onboarding-platform-monorepo#1")
  })

  test("keeps anything else as it is", () => {
    const url = "https://gitlab.com/a/b/-/merge_requests/1"
    expect(pullRequestName(url)).toBe(url)
  })
})
