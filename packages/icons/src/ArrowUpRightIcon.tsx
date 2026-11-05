import { Path, Svg, type IconProps } from "./primitives"

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M7 17L17 7M8.5 7H17v8.5" />
    </Svg>
  )
}
