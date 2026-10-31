import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function CloudOffIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d="M3.5 3.5l17 17" stroke="#000" strokeWidth="6" />
      </mask>
      <g mask={`url(#${id}a)`}>
        <path d="M7.5 19A4.5 4.5 0 0 1 7.02 10.03A5.5 5.5 0 0 1 17.97 11.12A4 4 0 0 1 17 19Z" />
      </g>
      <path d="M3.5 3.5l17 17" />
    </Icon>
  )
}
