import { Path, Svg, type IconProps } from "./primitives"

export function ArrowRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M5 12h14M13 6l6 6-6 6" />
    </Svg>
  )
}
