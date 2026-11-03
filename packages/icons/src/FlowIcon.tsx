import { Path, Rect, Svg, type IconProps } from "./primitives"

export function FlowIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="3.5" y="3.5" width="7" height="6" rx="2" />
      <Rect x="13.5" y="14.5" width="7" height="6" rx="2" />
      <Path d="M7 9.5v2a4 4 0 0 0 4 4h2.5" />
    </Svg>
  )
}
