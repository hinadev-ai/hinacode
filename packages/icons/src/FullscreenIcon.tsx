import { Path, Svg, type IconProps } from "./primitives"

export function FullscreenIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4 9V7a3 3 0 0 1 3-3h2M15 4h2a3 3 0 0 1 3 3v2M20 15v2a3 3 0 0 1-3 3h-2M9 20H7a3 3 0 0 1-3-3v-2" />
    </Svg>
  )
}
