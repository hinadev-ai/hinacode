import { useId } from "react"

import { G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function FeedbackFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Path d="M8.82 19.38A8.5 8.5 0 1 0 4.79 16L3.6 20.4Z" />
        </G>
        <G stroke="#000" fill="none">
          <Path d="M8.5 10h7M8.5 13.5h4" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Svg>
  )
}
