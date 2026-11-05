import { Path, Rect, Svg, type IconProps } from "./primitives"

export function MarkdownIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="2.5" y="5" width="19" height="14" rx="3" />
      <Path d="M6.5 15V9l2.5 3 2.5-3v6M16 9v6M13.5 12.5L16 15l2.5-2.5" />
    </Svg>
  )
}
