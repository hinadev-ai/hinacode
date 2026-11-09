import { readFile, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import { type Artifact, DOCUMENT_ENTRY, isTextType, WHITEBOARD_ENTRY } from "./artifact.ts"
import { type ArtifactComment, type CommentAuthor, waitingOnDeveloper } from "./feedback.ts"
import { ArtifactConflictError, type ArtifactStore, ArtifactError, MAX_ARTIFACT_BYTES } from "./store.ts"
import { describeScene, parseScene } from "./whiteboard.ts"

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

Write GitHub-flavored Markdown: headings, paragraphs, emphasis, links, lists, task lists (- [ ] item), tables, quotes and fenced code blocks. Raw HTML is dropped.

To change a document, pass its id, the revision you last published or read, and the full new Markdown, or the sourcePath of a file that holds it. read_artifact without a path shows the current revision. The developer may have edited it in the meantime. Then the call fails with their current text and revision, so merge your change into that text and publish again with that revision.`

const WHITEBOARD_GUIDE = `Draw on a whiteboard that the developer sees and draws on beside the thread: an architecture sketch, a flow, a state machine or a rough layout. Prefer it to publish_artifact when the picture is boxes and arrows the developer may want to move or extend.

Elements use Excalidraw's skeleton form. Give every element a stable, readable id such as "api" or "api-db", and x and y; shapes also take width and height.
- Shapes: {"id":"api","type":"rectangle","x":0,"y":0,"width":180,"height":80,"label":{"text":"API"}}. type is rectangle, ellipse or diamond.
- Text: {"id":"title","type":"text","x":0,"y":-60,"text":"Checkout flow"}.
- Arrows and lines: {"id":"api-db","type":"arrow","x":180,"y":40,"start":{"id":"api"},"end":{"id":"db"},"label":{"text":"reads"}}. type is arrow or line; start and end attach it to elements by id.
Optional style: strokeColor, backgroundColor, fillStyle "solid", strokeStyle "dashed". Leave about 120px between shapes. Use a frame ({"id":"backend","type":"frame","name":"Backend","children":["api","db"]}) only to group a large region.

The developer may draw too, so send only the elements you add or change; the rest stay. An element whose id exists is replaced whole, and remove deletes ids. read_artifact lists every element with its text and bounds. When you answer a question about some elements, place what you add next to them.`

const COMMENT_GUIDE = `Reply to a comment on an artifact, or start one. The developer's comments arrive as messages that name the artifact and the comment id. Answer each with this tool rather than in your reply text, and change the artifact too when the comment asks for it.

Start a comment to ask the developer about part of an artifact: pass quote with exact text from a document, elements with whiteboard element ids, or neither for the whole artifact. Set resolve when the comment is settled.`

const currentMarkdown = async (store: ArtifactStore, id: string) => {
  const file = await store.file(id, DOCUMENT_ENTRY)
  return file === null ? "" : new TextDecoder().decode(file.bytes)
}

const describeSourcePath = (holds: string) =>
  `The absolute path of a file on this machine that holds ${holds}. It is copied when you publish, so publish again after you change it.`

const cannotRead = (sourcePath: string, error: unknown) =>
  error instanceof ArtifactError ? error : new ArtifactError(`Cannot read sourcePath "${sourcePath}": ${String(error)}`)

const sourceSize = async (sourcePath: string) => {
  if (!isAbsolute(sourcePath)) throw new ArtifactError(`sourcePath must be absolute, but got "${sourcePath}".`)
  try {
    const source = await stat(sourcePath)
    if (!source.isFile()) throw new ArtifactError(`sourcePath "${sourcePath}" is not a file.`)
    return source.size
  } catch (error) {
    throw cannotRead(sourcePath, error)
  }
}

const readSources = async (sourcePaths: ReadonlyArray<string>, inlineBytes = 0) => {
  const sizes = await Promise.all(sourcePaths.map(sourceSize))
  const total = sizes.reduce((sum, size) => sum + size, inlineBytes)
  if (total > MAX_ARTIFACT_BYTES) {
    throw new ArtifactError(`The files are ${total} bytes. A version holds at most ${MAX_ARTIFACT_BYTES} bytes.`)
  }
  return Promise.all(
    sourcePaths.map((sourcePath) =>
      readFile(sourcePath).catch((error: unknown) => Promise.reject(cannotRead(sourcePath, error))),
    ),
  )
}

const base64Codes = new Uint8Array(128)
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_")
  base64Codes[character.charCodeAt(0)] = 1
const base64Padding = "=".charCodeAt(0)

const decodedBase64Size = (content: string) => {
  let codes = 0
  for (let index = 0; index < content.length; index++) {
    const code = content.charCodeAt(index)
    if (code === base64Padding) break
    if (code < base64Codes.length && base64Codes[code] === 1) codes += 1
  }
  return Math.floor((codes * 3) / 4)
}

const inlineSize = (file: { content?: string | undefined; encoding?: "utf8" | "base64" | undefined }) => {
  if (file.content === undefined) return 0
  return file.encoding === "base64" ? decodedBase64Size(file.content) : Buffer.byteLength(file.content, "utf8")
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true })

const utf8Text = (bytes: Uint8Array) => {
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return null
  }
}

const markdownIn = (sourcePath: string, bytes: Uint8Array) => {
  const text = utf8Text(bytes)
  if (text === null || text.includes("\0")) {
    throw new ArtifactError(`"${sourcePath}" is not UTF-8 text. A document's sourcePath must be Markdown.`)
  }
  return text
}

const newNeedsTitle = { message: "Give a new artifact a title.", path: ["title"] }

const describeTitle = (example: string) =>
  `The artifact's name, two to four words, such as "${example}". Required for a new one. Omit it when you update, to keep the name the developer may have changed.`

const authorName = (author: CommentAuthor) =>
  author.kind === "developer"
    ? "developer"
    : author.threadId === undefined
      ? "agent"
      : `agent (thread ${author.threadId})`

const anchorName = ({ anchor }: ArtifactComment) => {
  switch (anchor.kind) {
    case "artifact":
      return "on the whole artifact"
    case "text":
      return `on the quote ${JSON.stringify(anchor.quote)}`
    case "elements":
      return `on elements ${anchor.ids.join(", ")}`
  }
}

const describeComment = (comment: ArtifactComment) =>
  [
    `- ${comment.id} ${anchorName(comment)}, ${waitingOnDeveloper(comment) ? "waiting on the developer" : "waiting on you"}`,
    ...comment.messages.map((message) => `  ${authorName(message.author)}: ${message.body.replaceAll("\n", "\n    ")}`),
  ].join("\n")

const describeFeedback = async (store: ArtifactStore, artifact: Artifact) => {
  const feedback = await store.feedback(artifact.id)
  const open = feedback?.comments.filter((comment) => !comment.resolved) ?? []
  const sections = open.length === 0 ? [] : [`Open comments:\n${open.map(describeComment).join("\n")}`]
  if (artifact.kind === "whiteboard") {
    const file = await store.file(artifact.id, WHITEBOARD_ENTRY)
    const scene = file === null ? null : parseScene(new TextDecoder().decode(file.bytes))
    sections.push(`Elements:\n${describeScene(scene?.elements ?? [])}`)
  }
  return sections
}

const autoOpen = z
  .boolean()
  .optional()
  .describe(
    "Open it beside the thread as soon as it is published. Set it on the first publish of what the developer asked for. Leave it off for updates and side results, which the thread shows as a card the developer can click.",
  )

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
        auto_open: autoOpen,
      })
      .refine((input) => input.id !== undefined || input.title !== undefined, newNeedsTitle),
    handle: async (store, { auto_open: _autoOpen, ...input }, { threadId }) => {
      const sourced = input.files.flatMap(({ sourcePath }) => (sourcePath === undefined ? [] : [sourcePath]))
      const contents = await readSources(
        sourced,
        input.files.reduce((sum, file) => sum + inlineSize(file), 0),
      )
      const read = new Map(sourced.map((sourcePath, index) => [sourcePath, contents[index]]))
      const files = input.files.map(({ sourcePath, ...file }) =>
        sourcePath === undefined
          ? { ...file, content: file.content ?? "" }
          : { path: file.path, content: read.get(sourcePath)?.toString("base64") ?? "", encoding: "base64" as const },
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
        auto_open: autoOpen,
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
      const [bytes = Buffer.alloc(0)] = sourcePath === undefined ? [] : await readSources([sourcePath])
      const contents = sourcePath === undefined ? (markdown ?? "") : markdownIn(sourcePath, bytes)
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
          ...(kind === "page" ? {} : { kind }),
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
      "Read an artifact. Without a path, returns its manifest: kind, title, entry, version, revision and files, then its open comments and a whiteboard's elements. With a path, returns that text file's content. A document's Markdown is document.md.",
    input: z.object({
      id: z.string().describe("The artifact id."),
      path: z.string().optional().describe("A text file in the artifact, such as index.html."),
    }),
    handle: async (store, { id, path }) => {
      const artifact = await existing(store, id)
      if (path === undefined) {
        return [JSON.stringify(artifact, null, 2), ...(await describeFeedback(store, artifact))].join("\n\n")
      }
      const file = await store.file(id, path)
      if (!file) throw new ArtifactError(`Artifact ${id} has no file "${path}". Read the manifest to see its files.`)
      if (!isTextType(file.type))
        throw new ArtifactError(`"${path}" is binary (${file.type}) and cannot be read as text.`)
      return new TextDecoder().decode(file.bytes)
    },
  }),
  publish_whiteboard: tool({
    description: WHITEBOARD_GUIDE,
    input: z
      .object({
        id: z.string().optional().describe("The id of a whiteboard to change. Omit it to start a new whiteboard."),
        title: z.string().min(1).optional().describe(describeTitle("Checkout Flow")),
        elements: z
          .array(
            z.looseObject({
              id: z.string().min(1).describe('A stable, readable id, such as "api".'),
              type: z.string().describe("rectangle, ellipse, diamond, text, arrow, line or frame."),
            }),
          )
          .describe("Elements to add, or to replace whole when their id exists. Only what you add or change."),
        remove: z.array(z.string()).optional().describe("Ids of elements to delete."),
        auto_open: autoOpen,
      })
      .refine((input) => input.id !== undefined || input.title !== undefined, newNeedsTitle),
    handle: async (store, { id, title, elements, remove }, { threadId }) => {
      const whiteboard = await store.publish({
        kind: "whiteboard",
        patch: { upsert: elements, ...(remove === undefined ? {} : { remove }) },
        ...(id === undefined ? {} : { id }),
        ...(title === undefined ? {} : { title }),
        ...(threadId === undefined ? {} : { threadId }),
      })
      return `Published whiteboard ${whiteboard.id} version ${whiteboard.version}: "${whiteboard.title}". Pass id "${whiteboard.id}" to publish_whiteboard to add, change or remove elements.`
    },
  }),
  comment_on_artifact: tool({
    description: COMMENT_GUIDE,
    input: z
      .object({
        id: z.string().describe("The artifact id."),
        comment: z
          .string()
          .optional()
          .describe("The id of the comment to reply to, such as c_4f2a9k. Omit it to start a comment."),
        quote: z
          .string()
          .min(1)
          .optional()
          .describe("Start a comment on this exact text from the document, as it reads without Markdown marks."),
        elements: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe("Start a comment on these whiteboard element ids."),
        body: z.string().optional().describe("Your message, in Markdown."),
        resolve: z.boolean().optional().describe("true resolves the comment after your message, false reopens it."),
      })
      .refine((input) => input.quote === undefined || input.elements === undefined, {
        message: "Pass quote or elements, not both.",
        path: ["quote"],
      })
      .refine((input) => input.comment === undefined || (input.quote === undefined && input.elements === undefined), {
        message: "A reply keeps its comment's anchor. Omit quote and elements when you pass comment.",
        path: ["comment"],
      })
      .refine(
        (input) => (input.body ?? "").trim() !== "" || (input.comment !== undefined && input.resolve !== undefined),
        { message: "Pass a body, or comment and resolve to only resolve it.", path: ["body"] },
      ),
    handle: async (store, { id, comment, quote, elements, body, resolve }, { threadId }) => {
      const anchor =
        quote !== undefined
          ? { kind: "text" as const, quote, prefix: "", suffix: "" }
          : elements !== undefined
            ? { kind: "elements" as const, ids: elements }
            : undefined
      const saved = await store.comment(id, {
        author: threadId === undefined ? { kind: "agent" } : { kind: "agent", threadId },
        body: body ?? "",
        ...(comment === undefined ? {} : { comment }),
        ...(anchor === undefined ? {} : { anchor }),
        ...(resolve === undefined ? {} : { resolve }),
      })
      const state = saved.comment.resolved ? "It is resolved." : "The developer's answer arrives as a message."
      return comment === undefined
        ? `Started comment ${saved.comment.id} on artifact ${id}. ${state}`
        : `Replied on comment ${saved.comment.id} of artifact ${id}. ${state}`
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
