import { describe, expect, test } from "vitest"
import type { ArtifactComment, CommentAnchor, CommentMessage } from "./artifact.ts"
import { artifactFeedbackPrompt, feedbackTargets } from "./artifactFeedback.ts"

const message = (body: string, author: CommentMessage["author"] = { kind: "developer" }): CommentMessage => ({
  id: `m_${body.length}`,
  author,
  body,
  createdAt: "2026-11-08T09:00:00.000Z",
})

const commentOf = (anchor: CommentAnchor, ...messages: [CommentMessage, ...CommentMessage[]]): ArtifactComment => ({
  id: "c_4f2a9k",
  anchor,
  resolved: false,
  messages,
  createdAt: "2026-11-08T09:00:00.000Z",
  updatedAt: "2026-11-08T09:00:00.000Z",
})

describe("artifactFeedbackPrompt", () => {
  test("quotes the commented text of a document", () => {
    const comment = commentOf(
      { kind: "text", quote: "the migration runs before the deploy", prefix: "", suffix: "" },
      message("Should this be after? The deploy creates the table."),
    )
    expect(
      artifactFeedbackPrompt({
        artifact: { id: "k3n9", kind: "document", title: "Release Plan" },
        comment,
      }),
    ).toBe(
      [
        'Comment on document "Release Plan" (artifact k3n9, comment c_4f2a9k):',
        "> the migration runs before the deploy",
        "Should this be after? The deploy creates the table.",
        "",
        "Answer with comment_on_artifact, and change the document if needed.",
      ].join("\n"),
    )
  })

  test("names a reply, quotes every line and tells a mentioned thread to read the artifact", () => {
    const comment = commentOf(
      { kind: "text", quote: "first\nsecond", prefix: "", suffix: "" },
      message("Why?"),
      message("Because.", { kind: "agent", threadId: "t-1" }),
      message("@thread:t-2 what do you think?"),
    )
    expect(
      artifactFeedbackPrompt({
        artifact: { id: "k3n9", kind: "document", title: "Plan" },
        comment,
        mentioned: true,
      }),
    ).toBe(
      [
        'Reply on document "Plan" (artifact k3n9, comment c_4f2a9k):',
        "> first",
        "> second",
        "@thread:t-2 what do you think?",
        "",
        "You were mentioned. Read the artifact with read_artifact first.",
        "Answer with comment_on_artifact, and change the document if needed.",
      ].join("\n"),
    )
  })

  test("lists the selected elements of a whiteboard question", () => {
    expect(
      artifactFeedbackPrompt({
        artifact: { id: "w1", kind: "whiteboard", title: "Architecture" },
        comment: commentOf({ kind: "elements", ids: ["api", "db"] }, message("Where does the cache go?")),
        elements: 'api rectangle "API" at 0,0 180x80\ndb ellipse "Postgres" at 300,0 120x80',
      }),
    ).toBe(
      [
        'Comment on whiteboard "Architecture" (artifact w1, comment c_4f2a9k):',
        "About elements api, db:",
        'api rectangle "API" at 0,0 180x80',
        'db ellipse "Postgres" at 300,0 120x80',
        "Where does the cache go?",
        "",
        "Answer with comment_on_artifact, and change the whiteboard with publish_whiteboard if needed, placing new elements next to these.",
      ].join("\n"),
    )
  })

  test("comments on a whole artifact without an anchor", () => {
    expect(
      artifactFeedbackPrompt({
        artifact: { id: "p1", title: "Q3 Report" },
        comment: commentOf({ kind: "artifact" }, message("Add last year.")),
      }),
    ).toBe(
      [
        'Comment on page "Q3 Report" (artifact p1, comment c_4f2a9k):',
        "Add last year.",
        "",
        "Answer with comment_on_artifact.",
      ].join("\n"),
    )
  })
})

describe("feedbackTargets", () => {
  test("lists each mentioned thread once", () => {
    expect(feedbackTargets("Looks wrong")).toEqual([])
    expect(feedbackTargets("@thread:a and @thread:b-2, again @thread:a")).toEqual(["a", "b-2"])
    expect(feedbackTargets("@terminal:t1 only")).toEqual([])
  })
})
