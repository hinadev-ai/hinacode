import { Path, Svg, type IconProps } from "./primitives"

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 5v14M5 12h14" />
    </Svg>
  )
}
