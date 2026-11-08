import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
import {
  PUBLISH_ARTIFACT_TOOL,
  PUBLISH_DOCUMENT_TOOL,
  PUBLISH_WHITEBOARD_TOOL,
  publishedArtifactId,
  REQUEST_VERIFICATION_TOOL,
} from "../../../../shared/agent.ts"
import type { McpResult, MockStep } from "../play.ts"
import { say } from "./transcript.ts"

const COMMENT_ON_ARTIFACT_TOOL = "comment_on_artifact"
const READ_ARTIFACT_TOOL = "read_artifact"

const COMMENT_STEER = /^(?:Comment|Reply) on (document|whiteboard) .*\(artifact ([^,\s]+), comment ([^)\s]+)\):/
const VERDICT_STEER = /^Verification (".*") v(\d+): (passed|rejected)\./
const REVERIFY_ID = /request_verification again with id "([^"]+)"/
const ELEMENT_BOUNDS = /^\S+ \S+.* at (-?\d+),(-?\d+) (\d+)x(\d+)$/gm

type CommentSteer = { readonly kind: string; readonly artifactId: string; readonly commentId: string }

const commentSteer = (prompt: string): CommentSteer | null => {
  const [, kind, artifactId, commentId] = COMMENT_STEER.exec(prompt.trim()) ?? []
  return kind === undefined || artifactId === undefined || commentId === undefined
    ? null
    : { kind, artifactId, commentId }
}

export const feedbackScenario = (prompt: string) => {
  const steer = commentSteer(prompt)
  if (steer?.kind === "document") return "comments"
  if (steer?.kind === "whiteboard") return "whiteboard"
  return VERDICT_STEER.test(prompt.trim()) ? "verify" : undefined
}

const requestOf = (prompt: string, fallback: string) => prompt.replace(/^\s*\/mock-[a-z-]+\b/, "").trim() || fallback

const mcp = (name: string, input: Record<string, unknown>, next?: (result: McpResult) => Array<MockStep>): MockStep =>
  next === undefined ? { type: "mcp", name, input } : { type: "mcp", name, input, next }

const publishedThen = (failure: string, next: (id: string) => Array<MockStep>) => (result: McpResult) => {
  const id = result.isError ? null : publishedArtifactId(result.output)
  return id === null ? say(failure) : next(id)
}

export const QUESTION_QUOTE = "Ship it behind a flag on Friday"

const rolloutPlan = (title: string) => `# ${title}

## Rollout

The migration runs before the deploy, so the new column exists when the code reads it.

${QUESTION_QUOTE}, then turn it on for everyone on Monday.

## Risks

- The backfill locks the table for about a minute.
- Old clients ignore the flag.
`

export const commentSteps = (prompt: string): Array<MockStep> => {
  const steer = commentSteer(prompt)
  if (steer !== null) {
    return [
      mcp(COMMENT_ON_ARTIFACT_TOOL, {
        id: steer.artifactId,
        comment: steer.commentId,
        body: "Good point. I will fold that into the next revision.",
      }),
      ...say("Answered your comment."),
    ]
  }
  const title = requestOf(prompt, "Rollout Plan")
  return [
    ...say("Drafting the plan.\n\n"),
    mcp(
      PUBLISH_DOCUMENT_TOOL,
      { title, markdown: rolloutPlan(title), auto_open: true },
      publishedThen("Publishing the document failed.", (id) => [
        mcp(COMMENT_ON_ARTIFACT_TOOL, {
          id,
          quote: QUESTION_QUOTE,
          body: "Is Friday too late in the week? I can move it to Thursday.",
        }),
        ...say("I left a question on the Friday rollout."),
      ]),
    ),
  ]
}

const flow = [
  { id: "developer", type: "rectangle", x: 0, y: 0, width: 180, height: 80, label: { text: "Developer" } },
  { id: "agent", type: "ellipse", x: 300, y: 0, width: 180, height: 80, label: { text: "Agent" } },
  { id: "artifact", type: "diamond", x: 600, y: -10, width: 180, height: 100, label: { text: "Artifact" } },
  {
    id: "developer-agent",
    type: "arrow",
    x: 180,
    y: 40,
    start: { id: "developer" },
    end: { id: "agent" },
    label: { text: "asks" },
  },
  {
    id: "agent-artifact",
    type: "arrow",
    x: 480,
    y: 40,
    start: { id: "agent" },
    end: { id: "artifact" },
    label: { text: "publishes" },
  },
]

const besideAnchoredElements = (prompt: string) => {
  const boxes = [...prompt.matchAll(ELEMENT_BOUNDS)].map(([, x, y, width]) => ({
    right: Number(x) + Number(width),
    top: Number(y),
  }))
  if (boxes.length === 0) return { x: 0, y: -160 }
  return { x: Math.max(...boxes.map((box) => box.right)) + 40, y: Math.min(...boxes.map((box) => box.top)) }
}

export const whiteboardSteps = (prompt: string): Array<MockStep> => {
  const steer = commentSteer(prompt)
  if (steer !== null) {
    const note = {
      id: `note-${steer.commentId}`,
      type: "rectangle",
      ...besideAnchoredElements(prompt),
      width: 220,
      height: 100,
      backgroundColor: "#ffec99",
      fillStyle: "solid",
      strokeColor: "#f08c00",
      label: { text: "Agent note: covered" },
    }
    return [
      mcp(PUBLISH_WHITEBOARD_TOOL, { id: steer.artifactId, elements: [note] }),
      mcp(COMMENT_ON_ARTIFACT_TOOL, {
        id: steer.artifactId,
        comment: steer.commentId,
        body: "I added a note next to it.",
      }),
      ...say("Added a note beside your selection and answered the comment."),
    ]
  }
  return [
    ...say("Sketching the loop.\n\n"),
    mcp(PUBLISH_WHITEBOARD_TOOL, { title: requestOf(prompt, "Feedback Loop"), elements: flow, auto_open: true }),
    ...say("Draw on it, select what you drew and press Ask."),
  ]
}

type Rgb = readonly [number, number, number]
type Box = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly color: Rgb
}

const pngChunk = (type: string, data: Buffer) => {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, checksum])
}

export const boxesPng = (width: number, height: number, background: Rgb, boxes: ReadonlyArray<Box>) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const colorAt = (x: number, y: number) =>
    boxes.findLast((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height)?.color ??
    background
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x++) row.set(colorAt(x, y), 1 + x * 3)
    return row
  })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

const themes = {
  light: { background: [250, 250, 250], bar: [228, 228, 231], text: [63, 63, 70] },
  dark: { background: [24, 24, 27], bar: [39, 39, 42], text: [212, 212, 216] },
} satisfies Record<string, Record<string, Rgb>>

const screen = ({ background, bar, text }: (typeof themes)[keyof typeof themes], fixed: boolean) =>
  boxesPng(400, 240, background, [
    { x: 0, y: 0, width: 400, height: 36, color: bar },
    { x: 24, y: 64, width: 220, height: 12, color: text },
    { x: 24, y: 92, width: 300, height: 10, color: text },
    { x: 24, y: 112, width: 260, height: 10, color: text },
    { x: fixed ? 316 : 300, y: 188, width: 76, height: 32, color: [37, 99, 235] },
  ])

const captures = (version: number) => {
  const directory = mkdtempSync(join(tmpdir(), "hinacode-mock-verify-"))
  return (["light", "dark"] as const).map((theme) => {
    const sourcePath = join(directory, `${theme}.png`)
    writeFileSync(sourcePath, screen(themes[theme], version > 1))
    return { label: theme === "light" ? "Light" : "Dark", sourcePath }
  })
}

const mockup = (title: string) => `<!doctype html>
<html>
  <body style="font: 16px/1.5 system-ui, sans-serif; margin: 24px">
    <h1>${title.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)}</h1>
    <p>Two lines of settings copy, then the Save button at the bottom right, 8px from the edge.</p>
    <p style="text-align: right"><button>Save</button></p>
  </body>
</html>
`

const expectedPanes = (verifyJson: string): ReadonlyArray<Record<string, unknown>> => {
  try {
    const spec: unknown = JSON.parse(verifyJson)
    const expected = typeof spec === "object" && spec !== null ? Reflect.get(spec, "expected") : undefined
    return Array.isArray(expected) ? expected.filter((pane) => typeof Reflect.get(pane, "artifactId") === "string") : []
  } catch {
    return []
  }
}

export const verifySteps = (prompt: string): Array<MockStep> => {
  const [, title, version, decision] = VERDICT_STEER.exec(prompt.trim()) ?? []
  if (decision === "passed") return say(`Thanks. ${title} v${version} is done.`)
  const id = REVERIFY_ID.exec(prompt)?.[1]
  if (decision === "rejected" && id !== undefined) {
    return [
      mcp(READ_ARTIFACT_TOOL, { id, path: "verify.json" }, ({ output, isError }) => [
        mcp(REQUEST_VERIFICATION_TOOL, {
          id,
          notes: "Moved the Save button back to 8px from the edge.",
          expected: isError ? [] : expectedPanes(output),
          actual: captures(Number(version) + 1),
        }),
        ...say("Fixed it. The new version is waiting for your verdict."),
      ]),
    ]
  }
  const name = requestOf(prompt, "Settings Page")
  return [
    ...say("Publishing the approved mockup, then the screenshots I took.\n\n"),
    mcp(
      PUBLISH_ARTIFACT_TOOL,
      { title: `${name} Mockup`, files: [{ path: "index.html", content: mockup(name) }] },
      publishedThen("Publishing the mockup failed.", (artifactId) => [
        mcp(REQUEST_VERIFICATION_TOOL, {
          title: name,
          notes: "Check the Save button position in both themes.",
          expected: [{ label: "Approved mockup", artifactId }],
          actual: captures(1),
          auto_open: true,
        }),
        ...say("Pass it, or reject it with what is off."),
      ]),
    ),
  ]
}
