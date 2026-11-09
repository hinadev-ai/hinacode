import { useId } from "react"

import { Circle, G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function CheckCircleFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Circle cx="12" cy="12" r="10" />
        </G>
        <G stroke="#000" fill="none">
          <Path d="M8.5 12.5l2.5 2.5 4.5-5" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Svg>
  )
}
