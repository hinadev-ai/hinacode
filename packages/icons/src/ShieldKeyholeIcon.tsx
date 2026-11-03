import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function ShieldKeyholeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 3l7.5 3v5.5a8.5 8.5 0 0 1-7.5 9.5 8.5 8.5 0 0 1-7.5-9.5V6Z" />
      <Circle cx="12" cy="10.5" r="2" fill={sun} stroke="none" />
      <Path d="M12 12.5v3" />
    </Svg>
  )
}
