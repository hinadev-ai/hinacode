import { Path, Svg, type IconProps } from "./primitives"

export function ExpandIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 12h16M8.5 7.5L12 4l3.5 3.5M8.5 16.5L12 20l3.5-3.5" />
    </Svg>
  )
}
