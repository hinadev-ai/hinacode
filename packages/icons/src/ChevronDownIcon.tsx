import { Path, Svg, type IconProps } from "./primitives"

export function ChevronDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 9.5l6 6 6-6" />
    </Svg>
  )
}
