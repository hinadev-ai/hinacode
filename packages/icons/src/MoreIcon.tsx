import { Circle, sun, Svg, type IconProps } from "./primitives"

export function MoreIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="5" cy="12" r="2" fill={sun} stroke="none" />
      <Circle cx="12" cy="12" r="2" fill={sun} stroke="none" />
      <Circle cx="19" cy="12" r="2" fill={sun} stroke="none" />
    </Svg>
  )
}
