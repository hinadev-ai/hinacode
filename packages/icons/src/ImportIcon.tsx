import { Path, Svg, type IconProps } from "./primitives"

export function ImportIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 3.5v10.5M7.5 9.5L12 14l4.5-4.5M4 16.5v.5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-.5" />
    </Svg>
  )
}
