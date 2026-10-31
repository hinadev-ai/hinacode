import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function EyeFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <g fill="#fff" stroke="#fff">
          <path d="M2.5 12a10.6 10.6 0 0 1 19 0a10.6 10.6 0 0 1-19 0Z" />
        </g>
        <g stroke="#000" fill="none">
          <circle cx="12" cy="12" r="4.2" fill="#000" />
        </g>
      </mask>
      <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
      <circle cx="12" cy="12" r="2.2" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
