import { useId } from "react"

import { Circle, G, Mask, Path, Rect, sun, Svg, type IconProps } from "./primitives"

export function UnpinIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <Rect width="24" height="24" fill="#fff" />
        <Path d="M3.5 3.5l17 17" stroke="#000" strokeWidth="6" />
      </Mask>
      <G mask={`url(#${id}a)`}>
        <Circle cx="14.5" cy="9.5" r="4.5" fill={sun} stroke="none" />
        <Path d="M11.3 12.7L5 19" />
      </G>
      <Path d="M3.5 3.5l17 17" />
    </Svg>
  )
}
