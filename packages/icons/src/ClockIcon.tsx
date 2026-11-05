import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 7V12l3.5 2" />
      <Circle cx="12" cy="12" r="1.75" fill={sun} stroke="none" />
    </Svg>
  )
}
