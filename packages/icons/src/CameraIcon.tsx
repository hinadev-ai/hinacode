import { Circle, Path, Svg, type IconProps } from "./primitives"

export function CameraIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 9a3 3 0 0 1 3-3h1.5l1.5-2h4l1.5 2H17a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z" />
      <Circle cx="12" cy="13" r="3.5" />
    </Svg>
  )
}
