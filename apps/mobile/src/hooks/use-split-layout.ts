import { usePathname } from "expo-router"
import { Dimensions, useWindowDimensions } from "react-native"
import { create } from "zustand"
import { usePreferences } from "@/stores/preferences"

export const SIDEBAR_WIDTH = 360

const MIN_DETAIL_WIDTH = 420

const SPLIT_MIN_WIDTH = SIDEBAR_WIDTH + MIN_DETAIL_WIDTH

const isSplit = (width: number) => width >= SPLIT_MIN_WIDTH

export const useSplitLayout = () => isSplit(useWindowDimensions().width)

export const isSplitLayout = () => isSplit(Dimensions.get("window").width)

const useOverlay = create<{ openAt: string | null }>(() => ({ openAt: null }))

export const closeSidebarOverlay = () => useOverlay.setState({ openAt: null })

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
