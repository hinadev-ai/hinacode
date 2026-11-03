import { Path, Rect, sun, Svg, type IconProps } from "./primitives"

export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <Path d="M7.5 9.5l2.5 2.5-2.5 2.5" />
      <Rect x="13" y="9.5" width="3.5" height="5" rx="1" fill={sun} stroke="none" />
    </Svg>
  )
}
