import { Path, Svg, type IconProps } from "./primitives"

export function PiIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 7h16M9 7v12M15 7v9a3 3 0 0 0 3 3" />
    </Svg>
  )
}
