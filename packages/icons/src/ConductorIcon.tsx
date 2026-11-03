import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function ConductorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 20l7.5-7.5" />
      <Path d="M14 6a4 4 0 0 1 4 4" />
      <Path d="M14 2.5a7.5 7.5 0 0 1 7.5 7.5" />
      <Circle cx="13.5" cy="10.5" r="1.8" fill={sun} stroke="none" />
    </Svg>
  )
}
