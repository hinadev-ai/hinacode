import { Path, Svg, type IconProps } from "./primitives"

export function FolderMoveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M3.5 17V7A3 3 0 0 1 6.5 4h3.2a2 2 0 0 1 1.6.8l1.2 1.7h5a3 3 0 0 1 3 3V17a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3Z" />
      <Path d="M9 13.5h6M12.5 11l2.5 2.5-2.5 2.5" />
    </Svg>
  )
}
