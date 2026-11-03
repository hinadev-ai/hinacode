import { Path, Svg, type IconProps } from "./primitives"

export function PackageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 3l8 4v10l-8 4-8-4V7ZM4 7l8 4 8-4M12 11v10" />
    </Svg>
  )
}
