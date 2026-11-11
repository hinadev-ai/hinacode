import { create } from "zustand"
import type { Attachment } from "../../shared/domain.ts"
import { emptyLog, type EditLog } from "../lib/imageEdit/document.ts"
import type { EditSource } from "../lib/imageEdit/render.ts"
import { blobFromDataUrl } from "../lib/dataUrl.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { callPromise, type EnvironmentId } from "../lib/rpc.ts"

export type SourceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly source: EditSource }
  | { readonly status: "failed"; readonly message: string }

export interface EditorRequest {
  readonly threadId: string
  readonly attachment: Attachment
  readonly original: Attachment
  readonly log: EditLog
  readonly source: SourceState
}

interface EditSession {
  readonly original: Attachment
  readonly log: EditLog
}

interface ImageEditorState {
  readonly request: EditorRequest | null
  readonly sessions: Readonly<Record<string, EditSession>>
  readonly open: (threadId: string, attachment: Attachment, environment: EnvironmentId) => void
  readonly close: () => void
  readonly remember: (editedId: string, session: EditSession) => void
}

const loadSource = async (attachment: Attachment, environment: EnvironmentId): Promise<EditSource> => {
  const { dataUrl } = await callPromise("attachments.read", { path: attachment.path }, { environment })
  const image = await createImageBitmap(blobFromDataUrl(dataUrl))
  return { image, width: image.width, height: image.height }
}

export const useImageEditor = create<ImageEditorState>()((set, get) => ({
  request: null,
  sessions: {},
  open: (threadId, attachment, environment) => {
    const session = get().sessions[attachment.id]
    const original = session?.original ?? attachment
    const request: EditorRequest = {
      threadId,
      attachment,
      original,
      log: session?.log ?? emptyLog,
      source: { status: "loading" },
    }
    set({ request })
    const settle = (source: SourceState) => {
      if (get().request === request) set({ request: { ...request, source } })
    }
    loadSource(original, environment).then(
      (source) => settle({ status: "ready", source }),
      (cause: unknown) => settle({ status: "failed", message: errorMessage(cause) }),
    )
  },
  close: () => set({ request: null }),
  remember: (editedId, session) => set((state) => ({ sessions: { ...state.sessions, [editedId]: session } })),
}))
