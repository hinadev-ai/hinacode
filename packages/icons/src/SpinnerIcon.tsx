import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function SpinnerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="8.5" opacity=".2" />
      <Path d="M12 3.5A8.5 8.5 0 0 1 18.51 17.46" />
      <Circle cx="18.51" cy="17.46" r="2.25" fill={sun} stroke="none" />
    </Svg>
  )
}
