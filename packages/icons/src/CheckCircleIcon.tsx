import { Circle, Path, Svg, type IconProps } from "./primitives"

export function CheckCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </Svg>
  )
}
