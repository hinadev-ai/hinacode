import { Circle, Path, sun, Svg, type IconProps } from "./primitives"

export function PaletteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 3a9 9 0 0 0 0 18 2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.2h2.5a3.5 3.5 0 0 0 3.5-3.5A9 9 0 0 0 12 3Z" />
      <Circle cx="7.5" cy="12" r="1.4" fill={sun} stroke="none" />
      <Circle cx="9.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
      <Circle cx="14.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}
