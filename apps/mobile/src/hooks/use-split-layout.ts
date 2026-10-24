import { Dimensions, useWindowDimensions } from "react-native"

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
