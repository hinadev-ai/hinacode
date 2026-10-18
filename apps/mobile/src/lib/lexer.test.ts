import { describe, expect, it } from "vitest"
import type { SyntaxSpan } from "@/lib/highlight"
import { lex } from "./lexer"

function expectCovers(code: string, spans: readonly SyntaxSpan[]) {
  let at = 0
  for (const [index, span] of spans.entries()) {
    expect(span.start).toBe(at)
    expect(span.end).toBeGreaterThan(span.start)
    if (index > 0) expect(span.type).not.toBe(spans[index - 1].type)
    at = span.end
  }
  expect(at).toBe(code.length)
}

/** Each span's text with its class, leaving out plain text. */
const labeled = (code: string) =>
  lex(code)
    .filter((span) => span.type !== "plain")
    .map((span) => [span.type, code.slice(span.start, span.end)])

describe("lex", () => {
  it("covers the source with no gaps or overlaps", () => {
    const samples = [
      "",
      "x",
      "const a = 'unterminated\nlet b = \"\\\"\" // done",
      "/* open comment",
      "`multi\nline ${x}`",
      "'''doc\nstring''' + \"\"\"x\"\"\"",
      "it's a stray quote and another ' here",
      "0x1F 1_000 3.14e-10 10n 2.5f .5",
      "日本語 identifiers 🎉 (and emoji)",
    ]
    for (const code of samples) expectCovers(code, lex(code))
  })

  it("labels a TypeScript snippet", () => {
    const code = `export async function load(id: string): Promise<User> {
  // fetch the user
  const user = await fetchUser(id, { retries: 3 })
  return user ?? null
}`
    expectCovers(code, lex(code))
    expect(labeled(code)).toEqual([
      ["keyword", "export"],
      ["keyword", "async"],
      ["keyword", "function"],
      ["function", "load"],
      ["operator", ":"],
      ["keyword", "string"],
      ["operator", ":"],
      ["type", "Promise"],
      ["operator", "<"],
      ["type", "User"],
      ["operator", ">"],
      ["comment", "// fetch the user"],
      ["keyword", "const"],
      ["operator", "="],
      ["keyword", "await"],
      ["function", "fetchUser"],
      ["operator", ":"],
      ["number", "3"],
      ["keyword", "return"],
      ["operator", "??"],
      ["constant", "null"],
    ])
  })

  it("keeps a # inside a Python string out of comments", () => {
    const code = `def tag(name):
    # build the tag
    return "#" + name  # trailing
MAX_SIZE = None`
    expect(labeled(code)).toEqual([
      ["keyword", "def"],
      ["function", "tag"],
      ["operator", ":"],
      ["comment", "# build the tag"],
      ["keyword", "return"],
      ["string", '"#"'],
      ["operator", "+"],
      ["comment", "# trailing"],
      ["constant", "MAX_SIZE"],
      ["operator", "="],
      ["constant", "None"],
    ])
  })

  it("reads --flag in a shell line as an operator, not a comment", () => {
    const code = "pnpm test --filter mobile -- --watch # run it"
    expect(labeled(code)).toEqual([
      ["operator", "--"],
      ["comment", "-- --watch # run it"],
    ])
    expect(labeled("git log --oneline -3")).toEqual([
      ["operator", "--"],
      ["operator", "-"],
      ["number", "3"],
    ])
  })

  it("labels JSON", () => {
    const code = `{"name": "hinacode", "port": 47821, "debug": false, "tags": [null]}`
    expectCovers(code, lex(code))
    expect(labeled(code)).toEqual([
      ["string", '"name"'],
      ["operator", ":"],
      ["string", '"hinacode"'],
      ["string", '"port"'],
      ["operator", ":"],
      ["number", "47821"],
      ["string", '"debug"'],
      ["operator", ":"],
      ["constant", "false"],
      ["string", '"tags"'],
      ["operator", ":"],
      ["constant", "null"],
    ])
  })

  it("does not read a CSS color as a comment", () => {
    const code = `.button { color: #fff; margin: 0 4px; } /* end */`
    expect(labeled(code)).toEqual([
      ["operator", ":"],
      ["operator", ":"],
      ["number", "0"],
      ["number", "4px"],
      ["comment", "/* end */"],
    ])
  })

  it("reads SQL keywords and -- comments", () => {
    expect(labeled("SELECT id FROM users -- all of them")).toEqual([
      ["keyword", "SELECT"],
      ["keyword", "FROM"],
      ["comment", "-- all of them"],
    ])
  })

  it("lexes 200 KB in well under 100 ms", () => {
    const chunk = `function render(items: Item[]) {
  // draw each one
  for (const item of items) console.log("item", item.id, 0x1f, 'it\\'s', \`\${item}\`)
  return MAX_ITEMS >= items.length ? true : false /* clamp */
}
`
    const code = chunk.repeat(Math.ceil(200_000 / chunk.length))
    lex(code)
    const started = performance.now()
    const spans = lex(code)
    const elapsed = performance.now() - started
    expectCovers(code, spans)
    expect(elapsed).toBeLessThan(100)
  })

  it("stays linear on a line of stray quotes", () => {
    const code = "'\\".repeat(100_000)
    const started = performance.now()
    const spans = lex(code)
    expect(performance.now() - started).toBeLessThan(100)
    expectCovers(code, spans)
  })
})
