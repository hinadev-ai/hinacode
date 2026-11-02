import { Path, Svg, type IconProps } from "./primitives"

export function DatabaseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M5 6.5A10 10 0 0 1 19 6.5A10 10 0 0 1 5 6.5ZM5 6.5v11A10 10 0 0 0 19 17.5v-11M5 12A10 10 0 0 0 19 12" />
    </Svg>
  )
}
