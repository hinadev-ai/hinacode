import { Path, Svg, type IconProps } from "./primitives"

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  )
}
