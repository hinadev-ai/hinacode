import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function SteerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="7" />
      <Path d="M12 14.8L12 19M9.58 10.6L5.94 8.5M14.42 10.6L18.06 8.5" />
      <Circle cx="12" cy="12" r="2" fill={sun} stroke="none" />
    </Svg>
  )
}
