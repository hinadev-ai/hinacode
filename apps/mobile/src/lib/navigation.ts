import { router } from "expo-router"
import { closeSidebarOverlay, isSplitLayout } from "@/hooks/use-split-layout"

export const openThread = (id: string) => {
  // FIXME: expo-router keeps the route when the open thread is picked again, so the list slid over it would otherwise stay.
  closeSidebarOverlay()
  if (isSplitLayout() && router.canDismiss()) router.dismissAll()
  router.push({ pathname: "/thread/[id]", params: { id } })
}

export const leaveThread = () => (router.canDismiss() ? router.dismissAll() : router.replace("/"))
