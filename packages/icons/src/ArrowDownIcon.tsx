import { Path, Svg, type IconProps } from "./primitives"

export function ArrowDownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 5v14M6 13l6 6 6-6" />
    </Svg>
  )
}
