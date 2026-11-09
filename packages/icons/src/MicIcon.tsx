import { Path, Svg, type IconProps } from "./primitives"

export function MicIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Svg>
  )
}
