import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function BellIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5M4 16.5h16" />
      <Circle cx="12" cy="20" r="1.75" fill={sun} stroke="none" />
    </Svg>
  )
}
