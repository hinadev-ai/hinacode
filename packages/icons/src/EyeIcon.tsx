import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function EyeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M2.5 12a10.6 10.6 0 0 1 19 0a10.6 10.6 0 0 1-19 0Z" />
      <Circle cx="12" cy="12" r="3" fill={sun} stroke="none" />
    </Svg>
  )
}
