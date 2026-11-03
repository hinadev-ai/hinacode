import { Path, Svg, type IconProps } from "./primitives"

export function FlaskIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M9 3.5h6M10.2 3.5V9L5 18a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5.2-9V3.5M7.5 14.5h9" />
    </Svg>
  )
}
