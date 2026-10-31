import { expect, it } from "vitest"
import { rewriteMarkdownExtras } from "./markdown-extras"

it("leaves Markdown without keys or footnotes as is", () => {
  const markdown = "A <div> stays text, and so does <Suspense>.\n\n```ts\nconst a = 1\n```"
  expect(rewriteMarkdownExtras(markdown)).toBe(markdown)
})

it("turns <kbd> into a code span", () => {
  expect(rewriteMarkdownExtras("Press <kbd>Cmd</kbd> + <KBD>K</KBD>, not <div>.")).toBe("Press `Cmd` + `K`, not <div>.")
  expect(rewriteMarkdownExtras("<kbd>`</kbd>")).toBe("`` ` ``")
})

it("numbers footnote references in the order they are cited and lists the notes at the end", () => {
  const markdown = ["First[^b] then[^a], again[^b].", "", "[^a]: Note A.", "[^b]: Note <kbd>B</kbd>."].join("\n")
  expect(rewriteMarkdownExtras(markdown)).toBe(
    ["First¹ then², again¹.", "", "---", "", "1. Note `B`.", "2. Note A.", ""].join("\n"),
  )
})

it("writes numbers past nine in superscript digits", () => {
  const ids = Array.from({ length: 12 }, (_, index) => index + 1)
  const markdown = [ids.map((id) => `[^${id}]`).join(" "), "", ...ids.map((id) => `[^${id}]: Note ${id}.`)].join("\n")
  expect(rewriteMarkdownExtras(markdown).split("\n")[0]).toBe("¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ¹⁰ ¹¹ ¹²")
})

it("keeps a reference without a definition, and lists a definition nobody cites last", () => {
  expect(rewriteMarkdownExtras("Cited[^a] and missing[^x].\n\n[^z]: Uncited.\n[^a]: Cited.")).toBe(
    "Cited¹ and missing[^x].\n\n---\n\n1. Cited.\n2. Uncited.\n",
  )
})

it("leaves code spans and fenced code blocks as written", () => {
  const markdown = [
    "Use `<kbd>Cmd</kbd>` and `[^1]` in code[^1].",
    "",
    "```md",
    "<kbd>X</kbd> and [^1]",
    "[^1]: inside a fence",
    "```",
    "",
    "[^1]: The note.",
  ].join("\n")
  expect(rewriteMarkdownExtras(markdown)).toBe(
    [
      "Use `<kbd>Cmd</kbd>` and `[^1]` in code¹.",
      "",
      "```md",
      "<kbd>X</kbd> and [^1]",
      "[^1]: inside a fence",
      "```",
      "",
      "---",
      "",
      "1. The note.",
      "",
    ].join("\n"),
  )
})

it("names a bare pull request URL owner/repo#n", () => {
  expect(rewriteMarkdownExtras("Opened https://github.com/hinadev-ai/hinacode/pull/460.")).toBe(
    "Opened [hinadev-ai/hinacode#460](https://github.com/hinadev-ai/hinacode/pull/460).",
  )
  expect(rewriteMarkdownExtras("(https://github.com/a/b.c/pull/1)")).toBe("([a/b.c#1](https://github.com/a/b.c/pull/1))")
})

it("keeps the punctuation that ends a sentence out of a bare URL", () => {
  expect(rewriteMarkdownExtras("A bare URL autolinks: https://github.com/hinadev-ai/hinacode. Next.")).toBe(
    "A bare URL autolinks: <https://github.com/hinadev-ai/hinacode>. Next.",
  )
  expect(rewriteMarkdownExtras("See https://example.com/a?b=1, then go.")).toBe("See <https://example.com/a?b=1>, then go.")
  expect(rewriteMarkdownExtras("`https://example.com.` and <https://example.com>.")).toBe(
    "`https://example.com.` and <https://example.com>.",
  )
})

it("leaves pull request URLs in links, autolinks, code and HTML attributes, and other URLs, as written", () => {
  const markdown = [
    "[the PR](https://github.com/a/b/pull/1) and [https://github.com/a/b/pull/2](https://github.com/a/b/pull/2)",
    "<https://github.com/a/b/pull/3> and `https://github.com/a/b/pull/4`",
    '<a href="https://github.com/a/b/pull/5">',
    "https://github.com/a/b/pull/6/files and https://github.com/a/b/issues/7 and https://example.com/a/b/pull/8",
    "```sh",
    "https://github.com/a/b/pull/9",
    "```",
  ].join("\n")
  expect(rewriteMarkdownExtras(markdown)).toBe(markdown)
})

it("labels a fence with no language text, and leaves closing fences and fences inside a longer one", () => {
  const markdown = ["```", "plain", "```", "", "````md", "```", "inside", "```", "````", "", "~~~ ", "tilde", "~~~"].join(
    "\n",
  )
  expect(rewriteMarkdownExtras(markdown)).toBe(
    ["```text", "plain", "```", "", "````md", "```", "inside", "```", "````", "", "~~~text", "tilde", "~~~"].join("\n"),
  )
})
