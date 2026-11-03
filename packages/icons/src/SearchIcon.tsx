import { Circle, Path, Svg, type IconProps } from "./primitives"

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="10.5" cy="10.5" r="6.5" />
      <Path d="M15.5 15.5l4.5 4.5" />
    </Svg>
  )
}
