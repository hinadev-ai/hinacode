import { Path, Svg, type IconProps } from "./primitives"

export function VolumeUpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <Path d="M3 10a1.5 1.5 0 0 1 1.5-1.5H7L11.5 5v14L7 15.5H4.5A1.5 1.5 0 0 1 3 14Z" />
      <Path d="M14.33 9.17A4 4 0 0 1 14.33 14.83" />
      <Path d="M17.16 6.34A8 8 0 0 1 17.16 17.66" />
    </Svg>
  )
}
