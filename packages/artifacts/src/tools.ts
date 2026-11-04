import { readFile, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { DOCUMENT_ENTRY, isTextType } from "./artifact.ts"
import { CHART_GUIDE } from "./chartGuide.ts"
import { ArtifactConflictError, type ArtifactStore, ArtifactError, MAX_ARTIFACT_BYTES } from "./store.ts"

export type ArtifactCaller = { threadId?: string }

export type ArtifactTool<Input extends z.ZodObject = z.ZodObject> = {
  description: string
  input: Input
  handle(store: ArtifactStore, input: z.infer<Input>, caller: ArtifactCaller): Promise<string>
}

const tool = <Input extends z.ZodObject>(definition: ArtifactTool<Input>) => definition

const existing = async (store: ArtifactStore, id: string) => {
  const artifact = await store.get(id)
  if (!artifact) throw new ArtifactError(`No artifact has the id "${id}". Call list_artifacts to see the ids.`)
  return artifact
}

const PUBLISH_GUIDE = `Publish an HTML page for the developer to look at: a report, chart, diagram or prototype. Write one self-contained index.html with inline <style> and <script type="module">, so names like top or name do not clash with window globals. To change it, publish again with the same id and every file. A file already on disk takes its sourcePath instead of its content, so you never send the same text twice.

The page runs in a sandboxed frame with no origin: storage, cookies, alert/confirm/prompt, form submission, popups, downloads and links that leave the page do nothing. Keep state in memory and show URLs as text. CDN files load when the network allows; pin exact versions. At most ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.

The preview is a side panel, often 360 to 700px wide. Never scroll sideways: let rows wrap, give text-holding flex and grid children min-width: 0, and put wide tables and code in an overflow-x: auto box. No 100vh heroes. For icons, load https://cdn.jsdelivr.net/npm/remixicon@4.6.0/fonts/remixicon.css and write <i class="ri-git-branch-line"></i>; no emoji icons.`

const DOCUMENT_GUIDE = `Publish a Markdown document that the developer reads and edits beside the thread: a plan, spec, design note, checklist or notes. Prefer it to publish_artifact when the content is prose the developer may want to change.

Write GitHub-flavored Markdown: headings, paragraphs, emphasis, links, lists, task lists (- [ ] item), tables, quotes and fenced code blocks. Raw HTML is dropped. A document can also hold bar and line charts; call document_chart_guide before you write one.

To change a document, pass its id, the revision you last published or read, and the full new Markdown, or the sourcePath of a file that holds it. read_artifact without a path shows the current revision. The developer may have edited it in the meantime. Then the call fails with their current text and revision, so merge your change into that text and publish again with that revision.`

const currentMarkdown = async (store: ArtifactStore, id: string) => {
  const file = await store.file(id, DOCUMENT_ENTRY)
  return file === null ? "" : new TextDecoder().decode(file.bytes)
}

const describeSourcePath = (holds: string) =>
  `The absolute path of a file on this machine that holds ${holds}. It is copied when you publish, so publish again after you change it.`

const readSource = async (sourcePath: string) => {
  if (!isAbsolute(sourcePath)) throw new ArtifactError(`sourcePath must be absolute, but got "${sourcePath}".`)
  try {
    const source = await stat(sourcePath)
    if (!source.isFile()) throw new ArtifactError(`sourcePath "${sourcePath}" is not a file.`)
    if (source.size > MAX_ARTIFACT_BYTES) {
      throw new ArtifactError(
        `"${sourcePath}" is ${source.size} bytes. A version holds at most ${MAX_ARTIFACT_BYTES} bytes.`,
      )
    }
    return await readFile(sourcePath)
  } catch (error) {
    if (error instanceof ArtifactError) throw error
    throw new ArtifactError(`Cannot read sourcePath "${sourcePath}": ${String(error)}`)
  }
}

const newNeedsTitle = { message: "Give a new artifact a title.", path: ["title"] }

export const artifactTools = {
  publish_artifact: tool({
    description: PUBLISH_GUIDE,
    input: z
      .object({
        id: z
          .string()
          .optional()
          .describe("The id of an artifact to update in place. Omit it to publish a new artifact."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The artifact\'s name, two to four words specific to this page, such as "Q3 Latency Report". No explanation after a dash or colon. Required for a new artifact. Omit it when you update, to keep the name the developer may have changed.',
          ),
        entry: z
          .string()
          .regex(/\.html$/i, "The entry must be an .html file.")
          .optional()
          .describe('The HTML file the preview opens. Defaults to "index.html".'),
        files: z
          .array(
            z
              .object({
                path: z.string().describe('A relative path, such as "index.html" or "assets/chart.js".'),
                content: z.string().optional().describe("The file content, as text or base64."),
                encoding: z
                  .enum(["utf8", "base64"])
                  .optional()
                  .describe('"base64" for binary content. Defaults to "utf8".'),
                sourcePath: z
                  .string()
                  .optional()
                  .describe(`Instead of content. ${describeSourcePath("this file")}`),
              })
              .refine((file) => (file.content === undefined) !== (file.sourcePath === undefined), {
                message: "Pass either content or sourcePath.",
              }),
          )
          .min(1)
          .describe("Every file of this version. Files left out of an update are gone from the new version."),
      })
      .refine((input) => input.id !== undefined || input.title !== undefined, newNeedsTitle),
    handle: async (store, input, { threadId }) => {
      const files = await Promise.all(
        input.files.map(async ({ sourcePath, ...file }) =>
          sourcePath === undefined
            ? { ...file, content: file.content ?? "" }
            : {
                path: file.path,
                content: (await readSource(sourcePath)).toString("base64"),
                encoding: "base64" as const,
              },
        ),
      )
      const artifact = await store.publish({ ...input, files, ...(threadId === undefined ? {} : { threadId }) })
      return `Published artifact ${artifact.id} version ${artifact.version}: "${artifact.title}". Pass id "${artifact.id}" to publish_artifact to update it.`
    },
  }),
  publish_document: tool({
    description: DOCUMENT_GUIDE,
    input: z
      .object({
        id: z.string().optional().describe("The id of a document to update. Omit it to publish a new document."),
        revision: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("The revision you last published or read. Required with id."),
        title: z
          .string()
          .min(1)
          .optional()
          .describe(
            'The document\'s name, two to four words, such as "Release Plan". Required for a new document. Omit it when you update, to keep the name the developer may have changed.',
          ),
        markdown: z.string().optional().describe("The whole document as Markdown."),
        sourcePath: z
          .string()
          .optional()
          .describe(`Instead of markdown. ${describeSourcePath("the whole document")}`),
      })
      .refine((input) => (input.markdown === undefined) !== (input.sourcePath === undefined), {
        message: "Pass either markdown or sourcePath.",
        path: ["markdown"],
      })
      .refine((input) => input.id === undefined || input.revision !== undefined, {
        message: "Pass the revision you last published or read together with id.",
        path: ["revision"],
      })
      .refine((input) => input.id !== undefined || input.title !== undefined, newNeedsTitle),
    handle: async (store, { id, revision, title, markdown, sourcePath }, { threadId }) => {
      const contents = sourcePath === undefined ? (markdown ?? "") : (await readSource(sourcePath)).toString("utf8")
      try {
        const document = await store.publish({
          kind: "document",
          markdown: contents,
          ...(title === undefined ? {} : { title }),
          ...(id === undefined ? {} : { id }),
          ...(revision === undefined ? {} : { baseRevision: revision }),
          ...(threadId === undefined ? {} : { threadId }),
        })
        return `Published document ${document.id} version ${document.version}: "${document.title}". To update it, pass id "${document.id}" and revision ${document.revision} to publish_document.`
      } catch (error) {
        if (!(error instanceof ArtifactConflictError)) throw error
        const { current } = error
        throw new ArtifactError(
          `The developer edited document ${current.id} after your revision ${revision}. It is now at revision ${current.revision}, titled "${current.title}". Merge your change into their text below and publish again with revision ${current.revision}.\n\n${await currentMarkdown(store, current.id)}`,
        )
      }
    },
  }),
  document_chart_guide: tool({
    description: "Explain how to put a bar or line chart in a document. Call it before you write a chart.",
    input: z.object({}),
    handle: async () => CHART_GUIDE,
  }),
  list_artifacts: tool({
    description:
      "List the artifacts this conversation published, newest first, with their ids, titles and versions. Set all to list every conversation's artifacts.",
    input: z.object({
      all: z.boolean().optional().describe("List every conversation's artifacts, with the thread each came from."),
    }),
    handle: async (store, { all }, { threadId }) => {
      const everyone = all === true || threadId === undefined
      const artifacts = (await store.list()).filter((artifact) => everyone || artifact.threadId === threadId)
      if (artifacts.length === 0) return everyone ? "No artifacts yet." : "This conversation has no artifacts yet."
      return JSON.stringify(
        artifacts.map(({ id, kind, title, version, updatedAt, threadId: thread }) => ({
          id,
          ...(kind === "document" ? { kind } : {}),
          title,
          version,
          updatedAt,
          ...(all === true && thread !== undefined ? { threadId: thread } : {}),
        })),
        null,
        2,
      )
    },
  }),
  read_artifact: tool({
    description:
      "Read an artifact. Without a path, returns its manifest: kind, title, entry, version, revision and files. With a path, returns that text file's content. A document's Markdown is document.md.",
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
        content: [{ type: "text", text: await definition.handle(store, input, {}) }],
      }),
    )
  }
}
