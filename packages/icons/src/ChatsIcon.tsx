import { useId } from "react"

import { G, Mask, Path, Rect, Svg, type IconProps } from "./primitives"

export function ChatsIcon(props: IconProps) {
  const id = useId()
  return (
    <Svg {...props}>
      <Mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <Rect width="24" height="24" fill="#fff" />
        <Path
          d="M11.5 9.5h6a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-.5v2.5l-3-2.5h-2.5a3 3 0 0 1-3-3v-3.5a3 3 0 0 1 3-3Z"
          stroke="#000"
          strokeWidth="5"
          strokeLinecap="round"
        />
      </Mask>
      <G mask={`url(#${id}a)`}>
        <Path d="M6.5 3.5h7a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8l-3.5 3v-3.3a3 3 0 0 1-1-2.2v-4.5a3 3 0 0 1 3-3Z" />
      </G>
      <Path d="M11.5 9.5h6a3 3 0 0 1 3 3v3.5a3 3 0 0 1-3 3h-.5v2.5l-3-2.5h-2.5a3 3 0 0 1-3-3v-3.5a3 3 0 0 1 3-3Z" />
    </Svg>
  )
}
