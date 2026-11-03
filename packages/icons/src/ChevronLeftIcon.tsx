import { Path, Svg, type IconProps } from "./primitives"

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M14.5 6l-6 6 6 6" />
    </Svg>
  )
}
