import { useId } from "react"

import { Circle, G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function ArrowDownCircleFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Circle cx="12" cy="12" r="10" />
        </G>
        <G stroke="#000" fill="none">
          <Path d="M12 7v9.5M8 12.5l4 4 4-4" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Svg>
  )
}
