import { Schema } from "effect"

export const ArtifactFile = Schema.Struct({ path: Schema.String, type: Schema.String, size: Schema.Number })
export type ArtifactFile = typeof ArtifactFile.Type

export const ArtifactKind = Schema.Literals(["page", "document"])
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

export const ArtifactExportRequest = Schema.Struct({
  id: Schema.String,
  entry: Schema.String,
  title: Schema.String,
  format: Schema.Literals(["html", "pdf", "markdown"]),
  theme: Schema.String,
})
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
