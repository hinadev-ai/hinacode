import { Path, Svg, type IconProps } from "./primitives"

export function PipIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <Path
        d="M13.5 12h3a1.5 1.5 0 0 1 1.5 1.5v2a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-2a1.5 1.5 0 0 1 1.5-1.5Z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  )
}
