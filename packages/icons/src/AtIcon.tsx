import { Circle, Path, Svg, type IconProps } from "./primitives"

export function AtIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="3.5" />
      <Path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8" />
    </Svg>
  )
}
