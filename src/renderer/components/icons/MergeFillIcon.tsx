import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function MergeFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <g fill="#fff" stroke="#fff">
          <circle cx="12" cy="12" r="10" />
        </g>
        <g stroke="#000" fill="none">
          <path d="M8.5 7v10M8.5 9a4 4 0 0 0 4 4h3" />
          <circle cx="8.5" cy="7" r="1.8" fill="#000" stroke="none" />
          <circle cx="8.5" cy="17" r="1.8" fill="#000" stroke="none" />
          <circle cx="15.5" cy="13" r="1.8" fill="#000" stroke="none" />
        </g>
      </mask>
      <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Icon>
  )
}
