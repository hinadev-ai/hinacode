import { Path, Rect, Svg, type IconProps } from "./primitives"

export function CopyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M15.5 6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5" />
      <Rect x="8.5" y="8.5" width="12" height="12" rx="3" />
    </Svg>
  )
}
