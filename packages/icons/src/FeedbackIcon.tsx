import { Path, Svg, type IconProps } from "./primitives"

export function FeedbackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M8.82 19.38A8.5 8.5 0 1 0 4.79 16L3.6 20.4Z" />
      <Path d="M8.5 10h7M8.5 13.5h4" />
    </Svg>
  )
}
