import { Path, Svg, type IconProps } from "./primitives"

export function UnlinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M9 11.5l-2.5 2.5a3.5 3.5 0 0 0 5 5l2.5-2.5M15 12.5l2.5-2.5a3.5 3.5 0 0 0-5-5L10 7.5M4 9h2M9 4v2M20 15h-2M15 20v-2" />
    </Svg>
  )
}
