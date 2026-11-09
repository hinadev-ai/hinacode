import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function ShieldUserIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 3l7.5 3v5.5a8.5 8.5 0 0 1-7.5 9.5 8.5 8.5 0 0 1-7.5-9.5V6Z" />
      <Circle cx="12" cy="10" r="2.2" fill={sun} stroke="none" />
      <Path d="M8.5 16.5a3.5 3.5 0 0 1 7 0" />
    </Svg>
  )
}
