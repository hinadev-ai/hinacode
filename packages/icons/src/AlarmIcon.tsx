import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function AlarmIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="13" r="7.5" />
      <Path d="M3.5 6.5l3-3M20.5 6.5l-3-3" />
      <Path d="M12 9V13l2.5 1.5" />
      <Circle cx="12" cy="13" r="1.6" fill={sun} stroke="none" />
    </Svg>
  )
}
