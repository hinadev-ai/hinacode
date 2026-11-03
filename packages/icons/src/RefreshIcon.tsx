import { Path, Svg, type IconProps } from "./primitives"

export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M15.75 5.5A7.5 7.5 0 1 1 8.25 5.5" />
      <Path d="M7.34 8.89L8.25 5.5L4.87 4.6" />
    </Svg>
  )
}
