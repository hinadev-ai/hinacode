import { Path, Rect, Svg, type IconProps } from "./primitives"

export function UnarchiveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Rect x="3" y="4" width="18" height="5" rx="2.5" />
      <Path d="M5 9v8a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9M12 17v-4.5M9.75 14.5L12 12.25l2.25 2.25" />
    </Svg>
  )
}
