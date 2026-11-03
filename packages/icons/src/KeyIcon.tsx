import { Circle, Path, Svg, type IconProps } from "./primitives"

export function KeyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="8" cy="16" r="4" />
      <Path d="M10.9 13.1L19 5M16.5 7.5l2 2M14 10l1.5 1.5" />
    </Svg>
  )
}
