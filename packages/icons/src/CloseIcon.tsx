import { Path, Svg, type IconProps } from "./primitives"

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
    </Svg>
  )
}
