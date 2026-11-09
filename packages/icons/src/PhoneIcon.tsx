import { Circle, Rect, sun, Svg, type IconProps } from "./primitives"

export function PhoneIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="6.5" y="2.5" width="11" height="19" rx="3" />
      <Circle cx="12" cy="18" r="1.25" fill={sun} stroke="none" />
    </Svg>
  )
}
