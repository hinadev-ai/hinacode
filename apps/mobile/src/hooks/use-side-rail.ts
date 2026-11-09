import { createContext, useContext } from "react"
import type { EdgeInsets } from "react-native-safe-area-context"

/** The narrowest strip that counts as a rail. A phone in landscape insets both sides alike, so only the difference counts. */
const MIN_RAIL_WIDTH = 60

/** The rail's width from the window's insets, measured once at the root, as `SideRailContext` provides it. */
export function measureSideRail(insets: EdgeInsets) {
  const width = insets.right - insets.left
  return width >= MIN_RAIL_WIDTH ? width : 0
}

/**
 * The root's measure. A native tab lays its screen out inside the safe area and reports its own insets as zero, so a
 * screen there cannot measure the strip itself.
 */
export const SideRailContext = createContext(0)

/**
 * The width of the strip iPhone Duo's half-open outer display keeps at the trailing edge for its status bar, or 0 on
 * every other screen. The tabs' buttons move into it instead of crowding the narrowed content.
 */
export const useSideRail = () => useContext(SideRailContext)
