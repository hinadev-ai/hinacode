import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function FileImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M13.5 3H7.5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V9ZM13.5 3.5V7a2 2 0 0 0 2 2h3.5" />
      <Path d="M7.5 18.5l3-3 3 3" />
      <Circle cx="14.5" cy="14" r="1.4" fill={sun} stroke="none" />
    </Svg>
  )
}
