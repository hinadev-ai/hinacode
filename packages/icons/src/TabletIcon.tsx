import { Circle, Rect, sun, Svg, type IconProps } from "./primitives"

export function TabletIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="4.5" y="3" width="15" height="18" rx="3" />
      <Circle cx="12" cy="17.5" r="1.25" fill={sun} stroke="none" />
    </Svg>
  )
}
