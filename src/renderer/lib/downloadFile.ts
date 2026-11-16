import { toast } from "sonner"
import { m } from "../paraglide/messages.js"
import { toastError } from "./errorMessage.ts"
import { callPromise } from "./rpc.ts"

const fileNameOf = (path: string) => path.split(/[\\/]/).at(-1) ?? path

export const downloadFile = async (root: string, path: string) => {
  try {
    const saved = await callPromise("shell.download", { root, path })
    toast.success(m.explorer_downloaded({ name: fileNameOf(saved.path) }), {
      action: {
        label: m.panel_reveal(),
        onClick: () => void callPromise("shell.reveal", { path: saved.path }).catch(toastError),
      },
    })
  } catch (cause) {
    toastError(cause)
  }
}
