import { PUBLISH_DOCUMENT_TOOL, PUBLISH_WHITEBOARD_TOOL, publishedArtifactId } from "../../../../shared/agent.ts"
import type { McpResult, MockStep } from "../play.ts"
import { say } from "./transcript.ts"

const COMMENT_ON_ARTIFACT_TOOL = "comment_on_artifact"

const COMMENT_STEER = /^(?:Comment|Reply) on (document|whiteboard) .*\(artifact ([^,\s]+), comment ([^)\s]+)\):/
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
  return steer?.kind === "whiteboard" ? "whiteboard" : undefined
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
