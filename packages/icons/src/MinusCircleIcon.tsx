import { Circle, Path, Svg, type IconProps } from "./primitives"

export function MinusCircleIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M8 12h8" />
    </Svg>
  )
}
