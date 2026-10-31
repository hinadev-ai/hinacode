import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function HourglassFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <g fill="#fff" stroke="#fff">
          <circle cx="12" cy="12" r="10" />
        </g>
        <g stroke="#000" fill="none">
          <path d="M8.5 7h7M8.5 17h7M9.5 7l5 10M14.5 7l-5 10" />
        </g>
      </mask>
      <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Icon>
  )
}
