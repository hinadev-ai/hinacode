/// <reference types="vite/client" />
import { CALLOUT_TONES, calloutMarker } from "../../documentCallout.ts"

const sources = import.meta.glob<string>("./*.md", { query: "?raw", import: "default", eager: true })

export const fixtures: ReadonlyArray<{ readonly name: string; readonly markdown: string }> = Object.entries(sources)
  .map(([path, markdown]) => ({ name: path.slice("./".length, -".md".length), markdown }))
  .toSorted((a, b) => a.name.localeCompare(b.name))

const LARGE_DOCUMENT_LENGTH = 300_000

const paragraph = (i: number) =>
  `Paragraph ${i} explains the **plan** with *emphasis*, \`inline code\`, ~~old text~~ and a [link](https://example.com/${i}). ` +
  `日本語の文も混ぜる。中文句子也在这里。한국어 문장도 있다. 👩🏽‍💻 🇯🇵 👨‍👩‍👧‍👦`

const section = (i: number) => {
  const tone = CALLOUT_TONES[i % CALLOUT_TONES.length]!
  return [
    `## Section ${i}`,
    paragraph(i),
    `### Lists ${i}`,
    `- item one ${i}\n- item two with **bold**\n  - nested ${i}\n    1. deeper ${i}\n    2. deeper again\n      - deepest`,
    `3. third\n4. fourth\n5. fifth`,
    `- [ ] open task ${i}\n- [x] done task ${i}\n  - [ ] nested task ${i}`,
    `> ${calloutMarker(tone)}\n> Callout ${i} with *text*.\n>\n> - point ${i}\n> - point ${i + 1}`,
    `> A plain quote ${i}.`,
    "```ts\nconst value" + i + " = compute(" + i + ")\nexport default value" + i + "\n```",
    `Line one of ${i}\\\nline two after a hard break.`,
    paragraph(i + 1000),
    "---",
  ].join("\n\n")
}

const table = (rows: number) =>
  ["| Name | Owner | Status | Notes |", "| --- | :---: | ---: | --- |"]
    .concat(
      Array.from(
        { length: rows },
        (_, i) => `| row ${i} | owner ${i % 7} | ${i % 2 ? "open" : "done"} | note **${i}** \`a\\|b\` |`,
      ),
    )
    .join("\n")

const chart = (rows: number) =>
  "```chart\n" +
  JSON.stringify({
    type: "line",
    title: "Daily load",
    x: "day",
    series: [{ key: "a", label: "Requests" }, { key: "b" }],
    rows: Array.from({ length: rows }, (_, i) => ({ day: `d${i}`, a: i * 3, b: (i * 7) % 100 })),
  }) +
  "\n```"

const diagram = "```mermaid\nflowchart LR\n  A --> B\n```"

export function largeDocument() {
  const parts = [
    "# Large document",
    paragraph(0),
    chart(500),
    table(50),
    diagram,
    "![Diagram](images/diagram.png)",
    "```\nplain fence\n```",
  ]
  let length = parts.join("\n\n").length
  for (let i = 1; length < LARGE_DOCUMENT_LENGTH; i++) {
    const next = section(i)
    parts.push(next)
    length += next.length + 2
  }
  return parts.join("\n\n") + "\n"
}
