import { Circle, Path, Rect, sun, Svg, type IconProps } from "./primitives"

export function RobotIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="4" y="8" width="16" height="12" rx="3" />
      <Path d="M12 5.5V8" />
      <Circle cx="12" cy="4" r="1.6" fill={sun} stroke="none" />
      <Circle cx="9" cy="13.5" r="1.4" fill="currentColor" stroke="none" />
      <Circle cx="15" cy="13.5" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}
