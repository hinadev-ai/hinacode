import { Path, Svg, type IconProps } from "./primitives"

export function BoltIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M13.5 3L6 13.5h5.5L10.5 21 18 10.5h-5.5Z" />
    </Svg>
  )
}
