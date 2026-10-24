import { router } from "expo-router"
import { closeSidebarOverlay, isSplitLayout } from "@/hooks/use-split-layout"

export const openThread = (id: string) => {
  // Picking the open thread again keeps the route, so the list slid over it would otherwise stay.
  closeSidebarOverlay()
  // Beside the list, a thread replaces the open one, so the stack stays the home, one thread and its pages.
  if (isSplitLayout() && router.canDismiss()) router.dismissAll()
  router.push({ pathname: "/thread/[id]", params: { id } })
}
