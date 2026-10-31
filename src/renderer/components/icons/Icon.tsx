import type { ReactNode, SVGProps } from "react"

export type IconProps = SVGProps<SVGSVGElement>
export type IconComponent = (props: IconProps) => ReactNode

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
