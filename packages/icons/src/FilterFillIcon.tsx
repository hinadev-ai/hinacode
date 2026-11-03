import { useId } from "react"

import { G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function FilterFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <G fill="#fff" stroke="#fff">
          <Rect x="2.5" y="2.5" width="19" height="19" rx="4" />
        </G>
        <G stroke="#000" fill="none">
          <Path d="M7 8h10M9 12h6M11 16h2" />
        </G>
      </Mask>
      <Rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Svg>
  )
}
