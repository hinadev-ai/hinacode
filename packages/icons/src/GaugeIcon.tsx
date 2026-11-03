import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function GaugeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M5.49 18.46A8.5 8.5 0 1 1 18.51 18.46" />
      <Path d="M12 13l3.5-4" />
      <Circle cx="12" cy="13" r="2" fill={sun} stroke="none" />
    </Svg>
  )
}
