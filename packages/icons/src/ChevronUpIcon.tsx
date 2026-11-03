import { Path, Svg, type IconProps } from "./primitives"

export function ChevronUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 14.5l6-6 6 6" />
    </Svg>
  )
}
