import { Circle, Path, Svg, type IconProps } from "./primitives"

export function XCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M9 9l6 6M15 9l-6 6" />
    </Svg>
  )
}
