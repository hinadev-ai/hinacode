import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="4" fill={sun} stroke="none" />
      <Path d="M19 12L21 12M16.95 16.95L18.36 18.36M12 19L12 21M7.05 16.95L5.64 18.36M5 12L3 12M7.05 7.05L5.64 5.64M12 5L12 3M16.95 7.05L18.36 5.64" />
    </Svg>
  )
}
