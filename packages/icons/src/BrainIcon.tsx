import { Path, Svg, type IconProps } from "./primitives"

export function BrainIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 6.22A3.6 3.6 0 0 0 5.2 8.57A3.6 3.6 0 0 0 5.2 15.43A3.6 3.6 0 0 0 12 17.78ZM12 6.22A3.6 3.6 0 0 1 18.8 8.57A3.6 3.6 0 0 1 18.8 15.43A3.6 3.6 0 0 1 12 17.78Z" />
      <Path d="M12 12H10a2 2 0 0 1-2-2M12 12h2a2 2 0 0 0 2 2" />
    </Svg>
  )
}
