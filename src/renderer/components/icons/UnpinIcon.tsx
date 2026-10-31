import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function UnpinIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d="M3.5 3.5l17 17" stroke="#000" strokeWidth="6" />
      </mask>
      <g mask={`url(#${id}a)`}>
        <circle cx="14.5" cy="9.5" r="4.5" fill="var(--sun, currentColor)" stroke="none" />
        <path d="M11.3 12.7L5 19" />
      </g>
      <path d="M3.5 3.5l17 17" />
    </Icon>
  )
}
