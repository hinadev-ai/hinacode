import { Path, Svg, type IconProps } from "./primitives"

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M13.5 3H7.5a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3V9ZM13.5 3.5V7a2 2 0 0 0 2 2h3.5" />
    </Svg>
  )
}
