import { Path, Svg, type IconProps } from "./primitives"

export function SidebarFillIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <Path d="M6 4h3.5v16H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}
