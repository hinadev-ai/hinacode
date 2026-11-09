import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function FileMusicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M13.5 3H7.5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V9ZM13.5 3.5V7a2 2 0 0 0 2 2h3.5" />
      <Path d="M11.5 17V11.5l3.5 1" />
      <Circle cx="9.8" cy="17" r="2" fill={sun} stroke="none" />
    </Svg>
  )
}
