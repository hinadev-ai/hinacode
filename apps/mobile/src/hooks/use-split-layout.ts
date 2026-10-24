import { Dimensions, useWindowDimensions } from "react-native"

/**
 * Below this window width the app is one screen at a time, as on a phone. It goes by the window, not the device, so
 * a narrow Split View, Slide Over or Stage Manager window on an iPad gets the phone layout too.
 */
const SPLIT_MIN_WIDTH = 700

export const SIDEBAR_WIDTH = 360

const isSplit = (width: number) => width >= SPLIT_MIN_WIDTH

/** Whether the thread list sits next to the open thread. */
export const useSplitLayout = () => isSplit(useWindowDimensions().width)

/** The same answer outside React, for navigation helpers. */
export const isSplitLayout = () => isSplit(Dimensions.get("window").width)
