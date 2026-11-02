import { Path, Svg, type IconProps } from "./primitives"

export function StackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 4l8.5 4.5L12 13 3.5 8.5ZM3.5 13.5L12 18l8.5-4.5" />
    </Svg>
  )
}
