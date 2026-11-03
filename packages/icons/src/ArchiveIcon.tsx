import { Path, Rect, Svg, type IconProps } from "./primitives"

export function ArchiveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="3" y="4" width="18" height="5" rx="2.5" />
      <Path d="M5 9v8a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9M10 13h4" />
    </Svg>
  )
}
