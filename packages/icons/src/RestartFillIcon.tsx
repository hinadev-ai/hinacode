import { useId } from "react"

import { Circle, G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function RestartFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Circle cx="12" cy="12" r="10" />
        </G>
        <G stroke="#000" fill="none">
          <Path d="M14.4 7.84A4.8 4.8 0 1 1 9.6 7.84" />
          <Path d="M9.02 10.01L9.6 7.84L7.44 7.26" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Svg>
  )
}
