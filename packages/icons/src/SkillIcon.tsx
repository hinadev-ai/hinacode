import { Path, Svg, type IconProps } from "./primitives"

export const skillIconShape = (
  <>
    <Path d="M4.5 7.5 11 2l8.5 2.5L13 10Z" fill="currentColor" />
    <Path d="M4 11v6l8 4 8-4v-6M4 11l8 4 8-4M12 15v6" />
  </>
)

export function SkillIcon(props: IconProps) {
  return (
    <Svg aria-hidden {...props}>
      {skillIconShape}
    </Svg>
  )
}
