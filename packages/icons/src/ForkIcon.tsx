import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function ForkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="6" cy="5" r="2.25" fill={sun} stroke="none" />
      <Circle cx="18" cy="5" r="2.25" fill={sun} stroke="none" />
      <Circle cx="12" cy="19" r="2.25" fill={sun} stroke="none" />
      <Path d="M6 5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V5M12 10v9" />
    </Svg>
  )
}
