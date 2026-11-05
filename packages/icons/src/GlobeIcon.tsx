import { Circle, Path, Svg, type IconProps } from "./primitives"

export function GlobeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Circle cx="12" cy="12" r="9" />
      <Path d="M12 3a11 11 0 0 1 0 18a11 11 0 0 1 0-18ZM3 12h18" />
    </Svg>
  )
}
