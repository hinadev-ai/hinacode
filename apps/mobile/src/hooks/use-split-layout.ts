import { usePathname } from "expo-router"
import { Dimensions, useWindowDimensions } from "react-native"
import { create } from "zustand"
import { usePreferences } from "@/stores/preferences"

export const SIDEBAR_WIDTH = 360

/** The thread beside the list is never narrower than a large phone. */
const MIN_DETAIL_WIDTH = 420

/**
 * Below this window width the app is one screen at a time, as on a phone. It goes by the window, not the device, so
 * an iPad mini in portrait and a narrow Split View, Slide Over or Stage Manager window get the phone layout too.
 */
const SPLIT_MIN_WIDTH = SIDEBAR_WIDTH + MIN_DETAIL_WIDTH

const isSplit = (width: number) => width >= SPLIT_MIN_WIDTH

/** Whether the thread list sits next to the open thread. */
export const useSplitLayout = () => isSplit(useWindowDimensions().width)

/** The same answer outside React, for navigation helpers. */
export const isSplitLayout = () => isSplit(Dimensions.get("window").width)

/** The route the list was slid over, so going anywhere else closes it. */
const useOverlay = create<{ openAt: string | null }>(() => ({ openAt: null }))

export const closeSidebarOverlay = () => useOverlay.setState({ openAt: null })

/**
 * Where the thread list goes in a split, as in Mail: a landscape window keeps it beside the thread until the developer
 * hides it, and remembers that. A portrait window gives the thread the full width and slides the list over it on
 * request, until the developer picks something or taps outside it.
 */
export function useSidebar() {
  const { width, height } = useWindowDimensions()
  const pathname = usePathname()
  const hidden = usePreferences((state) => state.sidebarHidden)
  const openAt = useOverlay((state) => state.openAt)
  const beside = width > height
  const open = beside ? !hidden : openAt === pathname
  const toggle = () => {
    if (beside) usePreferences.getState().set({ sidebarHidden: open })
    else useOverlay.setState({ openAt: open ? null : pathname })
  }
  return { beside, open, toggle }
}
