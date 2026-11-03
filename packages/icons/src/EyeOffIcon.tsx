import { useId } from "react"

import { Circle, G, Mask, Path, Rect, sun, Svg, type IconProps } from "./primitives"

export function EyeOffIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <Rect width="24" height="24" fill="#fff" />
        <Path d="M3.5 3.5l17 17" stroke="#000" strokeWidth="6" />
      </Mask>
      <G mask={`url(#${id}a)`}>
        <Path d="M2.5 12a10.6 10.6 0 0 1 19 0a10.6 10.6 0 0 1-19 0Z" />
        <Circle cx="12" cy="12" r="3" fill={sun} stroke="none" />
      </G>
      <Path d="M3.5 3.5l17 17" />
    </Svg>
  )
}
