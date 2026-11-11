import { createContext, useContext } from "react"
import type { EdgeInsets } from "react-native-safe-area-context"

const MIN_RAIL_WIDTH = 60

export function measureSideRail(insets: EdgeInsets) {
  const width = insets.right - insets.left
  return width >= MIN_RAIL_WIDTH ? width : 0
}

// FIXME: A native tab lays its screen out inside the safe area and reports zero insets, so the root measures the strip for it.
export const SideRailContext = createContext(0)

export const useSideRail = () => useContext(SideRailContext)
