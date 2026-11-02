import { Circle, Svg, type IconProps } from "./primitives"

export function GripIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="9" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <Circle cx="15" cy="6" r="1.5" fill="currentColor" stroke="none" />
      <Circle cx="9" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <Circle cx="15" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <Circle cx="9" cy="18" r="1.5" fill="currentColor" stroke="none" />
      <Circle cx="15" cy="18" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  )
}
