import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function BranchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="7" cy="5" r="2.25" fill={sun} stroke="none" />
      <Circle cx="7" cy="19" r="2.25" fill={sun} stroke="none" />
      <Circle cx="17" cy="6" r="2.25" fill={sun} stroke="none" />
      <Path d="M7 5v14M17 6v3a6 6 0 0 1-6 6H7" />
    </Svg>
  )
}
