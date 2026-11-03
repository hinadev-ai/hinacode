import { Path, Svg, type IconProps } from "./primitives"

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path
        d="M9 6h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  )
}
