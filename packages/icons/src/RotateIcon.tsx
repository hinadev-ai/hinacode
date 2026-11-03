import { Path, Svg, type IconProps } from "./primitives"

export function RotateIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M15.75 5.5A7.5 7.5 0 1 1 8.25 5.5" />
      <Path d="M19.13 4.6L15.75 5.5L16.66 8.89" />
    </Svg>
  )
}
