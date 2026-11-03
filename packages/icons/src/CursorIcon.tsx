import { Path, Svg, type IconProps } from "./primitives"

export function CursorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 3.5v15l4-3.7 2.7 5.7 2.6-1.2-2.7-5.6H18Z" />
    </Svg>
  )
}
