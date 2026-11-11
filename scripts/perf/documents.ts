const paragraph = (i: number) =>
  `Paragraph ${i} explains the **plan** with *emphasis*, \`inline code\`, ~~old text~~ and a [link](https://example.com/${i}). 日本語の文も混ぜる。中文句子也在这里。`

const section = (i: number) =>
  [
    `## Section ${i}`,
    paragraph(i),
    `- item one ${i}\n- item two with **bold**\n  - nested ${i}\n  - nested again`,
    `1. first\n2. second\n3. third`,
    `- [ ] open task ${i}\n- [x] done task ${i}`,
    `> [!NOTE]\n> Callout ${i} with *text*.`,
    `> A plain quote ${i}.`,
    "```ts\nconst value" + i + " = compute(" + i + ")\nexport default value" + i + "\n```",
    paragraph(i + 1000),
    "---",
  ].join("\n\n")

const table = (rows: number) =>
  ["| Name | Owner | Status | Notes |", "| --- | --- | --- | --- |"]
    .concat(
      Array.from(
        { length: rows },
        (_, i) => `| row ${i} | owner ${i % 7} | ${i % 2 ? "open" : "done"} | note **${i}** |`,
      ),
    )
    .join("\n")

const chart = (rows: number) =>
  "```chart\n" +
  JSON.stringify({
    type: "line",
    x: "day",
    series: [{ key: "a" }, { key: "b" }],
    rows: Array.from({ length: rows }, (_, i) => ({ day: `d${i}`, a: i * 3, b: (i * 7) % 100 })),
  }) +
  "\n```"

export const documentSizes = { small: 2_000, medium: 30_000, large: 300_000 } as const
export type DocumentSize = keyof typeof documentSizes

export function documentOfSize(bytes: number) {
  const parts = ["# Document", paragraph(0)]
  if (bytes >= 100_000) parts.push(chart(500), table(50))
  for (let i = 1; new TextEncoder().encode(parts.join("\n\n")).length < bytes; i++) parts.push(section(i))
  return parts.join("\n\n") + "\n"
}

export function withFirstScreenParagraphChanged(markdown: string, edit: string) {
  const changed = markdown.replace(/^Paragraph 1 .*$/m, `Paragraph 1 now reads differently, edit ${edit}.`)
  if (changed === markdown) throw new Error("the document has no paragraph 1 to change")
  return changed
}
