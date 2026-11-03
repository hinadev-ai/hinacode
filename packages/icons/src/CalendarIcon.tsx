import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6.5 5h11a3 3 0 0 1 3 3v9.5a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3ZM3.5 10h17M8 3v4M16 3v4" />
      <Circle cx="8" cy="14.5" r="1.4" fill={sun} stroke="none" />
    </Svg>
  )
}
