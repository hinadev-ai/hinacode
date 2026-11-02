import { Circle, sun, Svg, type IconProps } from "./primitives"

export function MoreVerticalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="5" r="2" fill={sun} stroke="none" />
      <Circle cx="12" cy="12" r="2" fill={sun} stroke="none" />
      <Circle cx="12" cy="19" r="2" fill={sun} stroke="none" />
    </Svg>
  )
}
