import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function ImageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <Circle cx="8.5" cy="9" r="1.75" fill={sun} stroke="none" />
      <Path d="M4 17.5l5-5 7.5 7.5M14 15.5l2.5-2.5 4 4" />
    </Svg>
  )
}
