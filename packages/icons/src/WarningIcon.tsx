import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function WarningIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 7.5v5" />
      <Circle cx="12" cy="16" r="1.4" fill={sun} stroke="none" />
    </Svg>
  )
}
