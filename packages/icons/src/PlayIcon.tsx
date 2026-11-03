import { Circle, Path, Svg, type IconProps } from "./primitives"

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M10.5 9l4.5 3-4.5 3Z" fill="currentColor" />
    </Svg>
  )
}
