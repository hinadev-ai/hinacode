import { Path, Svg, type IconProps } from "./primitives"

export function GuideIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M12 2.5v19M12 4.5h6l2.75 2.75L18 10h-6M12 12.5H6l-2.75 2.75L6 18h6" />
    </Svg>
  )
}
