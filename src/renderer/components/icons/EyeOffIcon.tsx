import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function EyeOffIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d="M3.5 3.5l17 17" stroke="#000" strokeWidth="6" />
      </mask>
      <g mask={`url(#${id}a)`}>
        <path d="M2.5 12a10.6 10.6 0 0 1 19 0a10.6 10.6 0 0 1-19 0Z" />
        <circle cx="12" cy="12" r="3" fill="var(--sun, currentColor)" stroke="none" />
      </g>
      <path d="M3.5 3.5l17 17" />
    </Icon>
  )
}
