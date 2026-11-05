import { Path, Svg, type IconProps } from "./primitives"

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  )
}
