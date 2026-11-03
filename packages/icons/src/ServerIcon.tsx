import { Circle, Rect, sun, Svg, type IconProps } from "./primitives"

export function ServerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="3.5" y="4" width="17" height="7" rx="3" />
      <Rect x="3.5" y="13" width="17" height="7" rx="3" />
      <Circle cx="7.5" cy="7.5" r="1.25" fill={sun} stroke="none" />
      <Circle cx="7.5" cy="16.5" r="1.25" fill={sun} stroke="none" />
    </Svg>
  )
}
