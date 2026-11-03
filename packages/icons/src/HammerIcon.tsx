import { Path, Rect, Svg, type IconProps } from "./primitives"

export function HammerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="3" y="5.25" width="9" height="4.5" rx="2.25" transform="rotate(-45 7.5 7.5)" />
      <Path d="M9.1 9.1L19 19" />
    </Svg>
  )
}
