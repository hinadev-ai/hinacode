import { Path, Rect, Svg, type IconProps } from "./primitives"

export function HeadphonesIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M5 12a7 7 0 0 1 14 0" />
      <Rect x="2" y="13" width="6" height="8" rx="3" />
      <Rect x="16" y="13" width="6" height="8" rx="3" />
    </Svg>
  )
}
