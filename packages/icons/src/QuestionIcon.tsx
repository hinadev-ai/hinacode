import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function QuestionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M9.4 9.6A2.7 2.7 0 1 1 13.3 12L12 12.9V13.5" />
      <Circle cx="12" cy="16.8" r="1.3" fill={sun} stroke="none" />
    </Svg>
  )
}
