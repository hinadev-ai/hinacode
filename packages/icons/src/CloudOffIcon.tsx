import { useId } from "react"

import { G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function CloudOffIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <Rect width="24" height="24" fill="#fff" />
        <Path d="M3.5 3.5l17 17" stroke="#000" strokeWidth="6" />
      </Mask>
      <G mask={`url(#${id}a)`}>
        <Path d="M7.5 19A4.5 4.5 0 0 1 7.02 10.03A5.5 5.5 0 0 1 17.97 11.12A4 4 0 0 1 17 19Z" />
      </G>
      <Path d="M3.5 3.5l17 17" />
    </Svg>
  )
}
