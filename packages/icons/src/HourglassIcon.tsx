import { Circle, Path, Svg, type IconProps } from "./primitives"

export function HourglassIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M8.5 7.5h7M8.5 16.5h7M9.5 7.5l5 9M14.5 7.5l-5 9" />
    </Svg>
  )
}
