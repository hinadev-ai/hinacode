import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { isTextType } from "./artifact.ts"
import { type ArtifactStore, ArtifactError, MAX_ARTIFACT_BYTES } from "./store.ts"

export type ArtifactTool<Input extends z.ZodObject = z.ZodObject> = {
  description: string
  input: Input
  handle(store: ArtifactStore, input: z.infer<Input>): Promise<string>
}

const tool = <Input extends z.ZodObject>(definition: ArtifactTool<Input>) => definition

const existing = async (store: ArtifactStore, id: string) => {
  const artifact = await store.get(id)
  if (!artifact) throw new ArtifactError(`No artifact has the id "${id}". Call list_artifacts to see the ids.`)
  return artifact
}

export const artifactTools = {
  publish_artifact: tool({
    description: [
      "Publish something for the developer to look at: a report, a chart, a diagram, a prototype.",
      "Send a self-contained HTML page, or a few files with relative links between them.",
      "It renders in a sandboxed frame: scripts run, but the page has no origin, so it cannot use cookies, storage or the host's credentials.",
      "Inline what you can; external scripts and styles load only if the network allows them.",
      `A version holds at most ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.`,
      "The result has the artifact id. To change the artifact, publish again with the same id and the full set of files; the open preview reloads to the new version.",
    ].join(" "),
    input: z.object({
      id: z
        .string()
        .optional()
        .describe("The id of an artifact to update in place. Omit it to publish a new artifact."),
      title: z.string().min(1).describe("A short title for the artifact."),
      entry: z.string().optional().describe('The file the preview opens. Defaults to "index.html".'),
      files: z
        .array(
          z.object({
            path: z.string().describe('A relative path, such as "index.html" or "assets/chart.js".'),
            content: z.string().describe("The file content, as text or base64."),
            encoding: z.enum(["utf8", "base64"]).optional().describe('"base64" for binary files. Defaults to "utf8".'),
          }),
        )
        .min(1)
        .describe("Every file of this version. Files left out of an update are gone from the new version."),
    }),
    handle: async (store, input) => {
      const artifact = await store.publish(input)
      return `Published artifact ${artifact.id} version ${artifact.version}: "${artifact.title}". Pass id "${artifact.id}" to publish_artifact to update it.`
    },
  }),
  list_artifacts: tool({
    description: "List the published artifacts, newest first, with their ids, titles and versions.",
    input: z.object({}),
    handle: async (store) => {
      const artifacts = await store.list()
      if (artifacts.length === 0) return "No artifacts yet."
      return JSON.stringify(
        artifacts.map(({ id, title, version, updatedAt }) => ({ id, title, version, updatedAt })),
        null,
        2,
      )
    },
  }),
  read_artifact: tool({
    description:
      "Read an artifact. Without a path, returns its manifest: title, entry, version and files. With a path, returns that text file's content.",
    input: z.object({
      id: z.string().describe("The artifact id."),
      path: z.string().optional().describe("A text file in the artifact, such as index.html."),
    }),
    handle: async (store, { id, path }) => {
      const artifact = await existing(store, id)
      if (path === undefined) return JSON.stringify(artifact, null, 2)
      const file = await store.file(id, path)
      if (!file) throw new ArtifactError(`Artifact ${id} has no file "${path}". Read the manifest to see its files.`)
      if (!isTextType(file.type))
        throw new ArtifactError(`"${path}" is binary (${file.type}) and cannot be read as text.`)
      return new TextDecoder().decode(file.bytes)
    },
  }),
}

export const registerArtifactTools = (server: McpServer, store: ArtifactStore) => {
  for (const [name, definition] of Object.entries<ArtifactTool>(artifactTools)) {
    server.registerTool(
      name,
      { description: definition.description, inputSchema: definition.input },
      async (input) => ({
        content: [{ type: "text", text: await definition.handle(store, input) }],
      }),
    )
  }
}
