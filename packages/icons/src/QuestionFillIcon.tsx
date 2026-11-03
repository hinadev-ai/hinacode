import { useId } from "react"

import { Circle, G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function QuestionFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Circle cx="12" cy="12" r="10" />
        </G>
        <G stroke="#000" fill="none">
          <Path d="M9.4 9.6A2.7 2.7 0 1 1 13.3 12L12 12.9V13.5" />
          <Circle cx="12" cy="16.8" r="1.3" fill="#000" stroke="none" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Svg>
  )
}
