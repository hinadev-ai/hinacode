import { Circle, Path, Svg, type IconProps } from "./primitives"

export function SlidersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 7h9M18 7h2M4 17h2M11 17h9" />
      <Circle cx="15.5" cy="7" r="2.5" />
      <Circle cx="8.5" cy="17" r="2.5" />
    </Svg>
  )
}
