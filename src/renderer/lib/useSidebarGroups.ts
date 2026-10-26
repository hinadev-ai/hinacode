import { useAtomSet } from "@effect/atom-react"
import { toast } from "sonner"
import type { SidebarGroups } from "../../shared/domain.ts"
import { m } from "../paraglide/messages.js"
import { errorMessage } from "./errorMessage.ts"
import { updateClientSettingsAtom } from "./rpc.ts"
import { useClientSettings } from "./settings.ts"

export function useSidebarGroups() {
  const { sidebarGroups } = useClientSettings()
  const save = useAtomSet(updateClientSettingsAtom, { mode: "promise" })
  const update = async (change: (state: SidebarGroups) => SidebarGroups) => {
    try {
      await save({ sidebarGroups: change(sidebarGroups) })
    } catch (cause) {
      toast.error(m.sidebar_group_save_failed({ message: errorMessage(cause) }))
    }
  }
  return [sidebarGroups, update] as const
}
