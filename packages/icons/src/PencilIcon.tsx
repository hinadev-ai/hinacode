import { Path, Svg, type IconProps } from "./primitives"

export function PencilIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M4.5 19.5l1-4.5L15.3 5.2a2.4 2.4 0 0 1 3.5 3.5L9 18.5ZM13.5 7l3.5 3.5" />
    </Svg>
  )
}
