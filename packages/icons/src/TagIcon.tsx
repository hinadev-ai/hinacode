import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M3.5 5.5v5.2a2 2 0 0 0 .6 1.4l7.8 7.8a2 2 0 0 0 2.8 0l5.2-5.2a2 2 0 0 0 0-2.8L12.1 4.1a2 2 0 0 0-1.4-.6H5.5a2 2 0 0 0-2 2Z" />
      <Circle cx="8" cy="8" r="1.6" fill={sun} stroke="none" />
    </Svg>
  )
}
