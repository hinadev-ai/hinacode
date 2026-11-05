import { Path, Svg, type IconProps } from "./primitives"

export function UndoIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M9 4.5L4.5 9 9 13.5M4.5 9H14a5.5 5.5 0 0 1 0 11h-4" />
    </Svg>
  )
}
