import type { ReactNode, SVGProps } from "react"

export type IconProps = SVGProps<SVGSVGElement>
export type IconComponent = (props: IconProps) => ReactNode

/** Base for HinaCode's icons: a 24-unit grid stroked at 2.4 in `currentColor`, sized `1em` like react-icons. */
export function Icon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  )
}
