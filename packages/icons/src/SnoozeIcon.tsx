import { Circle, Path, Svg, type IconProps } from "./primitives"

export function SnoozeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="13" r="7.5" />
      <Path d="M3.5 6.5l3-3M20.5 6.5l-3-3" />
      <Path d="M10 10.5h4l-4 5h4" />
    </Svg>
  )
}
