import { Schema } from "effect"

export const ArtifactFile = Schema.Struct({ path: Schema.String, type: Schema.String, size: Schema.Number })
export type ArtifactFile = typeof ArtifactFile.Type

export const ArtifactKind = Schema.Literals(["page", "document", "whiteboard"])
export type ArtifactKind = typeof ArtifactKind.Type

export const Artifact = Schema.Struct({
  id: Schema.String,
  kind: Schema.optionalKey(ArtifactKind),
  title: Schema.String,
  entry: Schema.String,
  version: Schema.Number,
  revision: Schema.optionalKey(Schema.Number),
  files: Schema.Array(ArtifactFile),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  threadId: Schema.optionalKey(Schema.String),
  environmentId: Schema.optionalKey(Schema.String),
})
export type Artifact = typeof Artifact.Type

export const ArtifactExportRequest = Schema.Union([
  Schema.Struct({
    format: Schema.Literals(["html", "pdf"]),
    id: Schema.String,
    entry: Schema.String,
    title: Schema.String,
    theme: Schema.String,
  }),
  Schema.Struct({
    format: Schema.Literals(["document-pdf", "document-markdown"]),
    title: Schema.String,
    theme: Schema.String,
    body: Schema.String,
  }),
])
export type ArtifactExportRequest = typeof ArtifactExportRequest.Type

export const isDocument = (artifact: Artifact) => artifact.kind === "document"

export const DocumentContent = Schema.Struct({
  version: Schema.Number,
  revision: Schema.Number,
  markdown: Schema.String,
})
export type DocumentContent = typeof DocumentContent.Type

export const DocumentSaveResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("saved"), version: Schema.Number, revision: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("conflict"),
    version: Schema.Number,
    revision: Schema.Number,
    markdown: Schema.String,
  }),
])
export type DocumentSaveResult = typeof DocumentSaveResult.Type

export const WhiteboardElement = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  Schema.Record(Schema.String, Schema.Unknown),
])
export type WhiteboardElement = typeof WhiteboardElement.Type

export const WhiteboardScene = Schema.Struct({
  elements: Schema.Array(WhiteboardElement),
  files: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type WhiteboardScene = typeof WhiteboardScene.Type

export const WhiteboardContent = Schema.Struct({
  version: Schema.Number,
  revision: Schema.Number,
  scene: WhiteboardScene,
})
export type WhiteboardContent = typeof WhiteboardContent.Type

export const WhiteboardSaveResult = Schema.Union([
  Schema.Struct({ type: Schema.Literal("saved"), version: Schema.Number, revision: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("conflict"),
    version: Schema.Number,
    revision: Schema.Number,
    scene: WhiteboardScene,
  }),
])
export type WhiteboardSaveResult = typeof WhiteboardSaveResult.Type

export const CommentAuthor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("developer") }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: Schema.optionalKey(Schema.String) }),
])
export type CommentAuthor = typeof CommentAuthor.Type

export const CommentMessage = Schema.Struct({
  id: Schema.String,
  author: CommentAuthor,
  body: Schema.String,
  createdAt: Schema.String,
})
export type CommentMessage = typeof CommentMessage.Type

export const CommentAnchor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("artifact") }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    quote: Schema.NonEmptyString,
    prefix: Schema.String,
    suffix: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("elements"), ids: Schema.Array(Schema.String).check(Schema.isMinLength(1)) }),
])
export type CommentAnchor = typeof CommentAnchor.Type

export const ArtifactComment = Schema.Struct({
  id: Schema.String,
  anchor: CommentAnchor,
  resolved: Schema.Boolean,
  messages: Schema.NonEmptyArray(CommentMessage),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type ArtifactComment = typeof ArtifactComment.Type

export const ArtifactFeedback = Schema.Struct({
  comments: Schema.Array(ArtifactComment),
})
export type ArtifactFeedback = typeof ArtifactFeedback.Type

export const waitingOnDeveloper = (comment: ArtifactComment) =>
  !comment.resolved && comment.messages.at(-1)?.author.kind === "agent"
