import { Path, Svg, type IconProps } from "./primitives"

export function PulseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
    </Svg>
  )
}
