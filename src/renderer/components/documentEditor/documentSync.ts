import type { Editor } from "@tiptap/core"
import type { DocumentContent } from "../../../shared/artifact.ts"
import { createDocumentSync as createSharedSync, type SaveStatus } from "../../../shared/document/sync.ts"
import { errorMessage } from "../../lib/errorMessage.ts"
import { callPromise, type EnvironmentId } from "../../lib/rpc.ts"

export type { SaveStatus }

export type DocumentSync = ReturnType<typeof createDocumentSync>

export function createDocumentSync({
  id,
  environment,
  loaded,
  onStatus,
}: {
  readonly id: string
  readonly environment: EnvironmentId
  readonly loaded: DocumentContent
  readonly onStatus: (status: SaveStatus) => void
}) {
  const sync = createSharedSync({
    key: JSON.stringify([environment, id]),
    loaded,
    onStatus,
    describe: errorMessage,
    rpc: {
      save: ({ baseRevision, markdown }) =>
        callPromise("artifacts.saveDocument", { id, baseRevision, markdown }, { environment }),
      read: () => callPromise("artifacts.readDocument", { id }, { environment }),
    },
  })
  return {
    ...sync,
    start: (editor: Editor) =>
      sync.start({
        markdown: () => editor.getMarkdown(),
        load: (markdown) => editor.commands.setContent(markdown, { contentType: "markdown", emitUpdate: false }),
        live: () => !editor.isDestroyed,
      }),
  }
}
