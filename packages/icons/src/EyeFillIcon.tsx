import { useId } from "react"

import { Circle, G, Mask, Path, Rect, sun, Svg, type IconProps } from "./primitives"

export function EyeFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Path d="M2.5 12a10.6 10.6 0 0 1 19 0a10.6 10.6 0 0 1-19 0Z" />
        </G>
        <G stroke="#000" fill="none">
          <Circle cx="12" cy="12" r="4.2" fill="#000" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
      <Circle cx="12" cy="12" r="2.2" fill={sun} stroke="none" />
    </Svg>
  )
}
