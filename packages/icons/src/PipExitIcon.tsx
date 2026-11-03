import { Path, Svg, type IconProps } from "./primitives"

export function PipExitIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <Path d="M8 8.5l5 5M8 12.5v-4h4" />
    </Svg>
  )
}
