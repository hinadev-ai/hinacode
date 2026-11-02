import { Schema } from "effect"

export const ArtifactFile = Schema.Struct({ path: Schema.String, type: Schema.String, size: Schema.Number })
export type ArtifactFile = typeof ArtifactFile.Type

export const Artifact = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  entry: Schema.String,
  version: Schema.Number,
  files: Schema.Array(ArtifactFile),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  environmentId: Schema.optionalKey(Schema.String),
})
export type Artifact = typeof Artifact.Type

export const ArtifactExportRequest = Schema.Struct({
  id: Schema.String,
  entry: Schema.String,
  title: Schema.String,
  format: Schema.Literals(["html", "pdf"]),
  theme: Schema.String,
})
export type ArtifactExportRequest = typeof ArtifactExportRequest.Type
