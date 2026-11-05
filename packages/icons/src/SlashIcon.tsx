import { Path, Rect, Svg, type IconProps } from "./primitives"

export const slashIconShape = (
  <>
    <Rect x="3" y="3" width="18" height="18" rx="3" />
    <Path d="M14.5 7.5l-5 9" />
  </>
)

export function SlashIcon(props: IconProps) {
  return <Svg {...props}>{slashIconShape}</Svg>
}
