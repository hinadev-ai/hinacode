import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function FilterFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <g fill="#fff" stroke="#fff">
          <rect x="2.5" y="2.5" width="19" height="19" rx="4" />
        </g>
        <g stroke="#000" fill="none">
          <path d="M7 8h10M9 12h6M11 16h2" />
        </g>
      </mask>
      <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Icon>
  )
}
