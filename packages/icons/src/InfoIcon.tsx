import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function InfoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Circle cx="12" cy="8" r="1.4" fill={sun} stroke="none" />
      <Path d="M12 11v5.5" />
    </Svg>
  )
}
