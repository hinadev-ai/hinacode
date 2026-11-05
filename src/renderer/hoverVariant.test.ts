import { readFile } from "node:fs/promises"
import { compile } from "tailwindcss"
import { expect, test } from "vitest"

const hoverVariant = async () => {
  const css = await readFile(new URL("./index.css", import.meta.url), "utf8")
  const variant = css.match(/@custom-variant hover \{[\s\S]*?\n\}/)?.[0]
  if (variant === undefined) throw new Error("index.css has no hover variant")
  return variant
}

test("not-hover negates the whole pointer media query", async () => {
  const compiler = await compile(`${await hoverVariant()}\n@tailwind utilities;`)
  const output = compiler.build(["not-hover:opacity-60"])
  expect(output).toContain("@media not ((hover: hover) and (pointer: fine))")
  expect(output).not.toMatch(/@media not \(hover: hover\) and/)
})
