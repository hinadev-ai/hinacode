import { Path, Svg, type IconProps } from "./primitives"

export function PlugIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M9 3.5v4M15 3.5v4M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0ZM12 16v4.5" />
    </Svg>
  )
}
