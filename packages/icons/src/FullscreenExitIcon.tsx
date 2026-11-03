import { Path, Svg, type IconProps } from "./primitives"

export function FullscreenExitIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M9 4v2a3 3 0 0 1-3 3H4M20 9h-2a3 3 0 0 1-3-3V4M15 20v-2a3 3 0 0 1 3-3h2M4 15h2a3 3 0 0 1 3 3v2" />
    </Svg>
  )
}
