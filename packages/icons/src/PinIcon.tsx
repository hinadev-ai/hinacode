import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function PinIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="14.5" cy="9.5" r="4.5" fill={sun} stroke="none" />
      <Path d="M11.3 12.7L5 19" />
    </Svg>
  )
}
