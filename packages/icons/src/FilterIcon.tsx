import { Path, Svg, type IconProps } from "./primitives"

export function FilterIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 6.5h16M7 12h10M10 17.5h4" />
    </Svg>
  )
}
