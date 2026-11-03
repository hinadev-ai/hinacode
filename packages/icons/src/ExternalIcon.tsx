import { Path, Svg, type IconProps } from "./primitives"

export function ExternalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M19.5 13.5V17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3h3.5M14 4h6v6M20 4l-8.5 8.5" />
    </Svg>
  )
}
