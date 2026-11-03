import { Path, Svg, type IconProps } from "./primitives"

export function ArrowUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  )
}
