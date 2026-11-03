import { Circle, Svg, type IconProps } from "./primitives"

export function CircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
    </Svg>
  )
}
