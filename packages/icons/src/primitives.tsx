import type { ReactNode, SVGProps } from "react"

export type IconProps = SVGProps<SVGSVGElement>
export type IconComponent = (props: IconProps) => ReactNode

export const iconAttributes = {
  viewBox: "0 0 24 24",
  width: "1em",
  height: "1em",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.4",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

export const sun = "var(--sun, currentColor)"

export function Svg(props: IconProps) {
  return <svg {...iconAttributes} {...props} />
}

export const Path = "path"
export const Circle = "circle"
export const Rect = "rect"
export const G = "g"
export const Mask = "mask"
