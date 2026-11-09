import { Path, Svg, type IconProps } from "./primitives"

export function CollapseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 12h16M8.5 4.5L12 8l3.5-3.5M8.5 19.5L12 16l3.5 3.5" />
    </Svg>
  )
}
