import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function QuestionFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <g fill="#fff" stroke="#fff">
          <circle cx="12" cy="12" r="10" />
        </g>
        <g stroke="#000" fill="none">
          <path d="M9.4 9.6A2.7 2.7 0 1 1 13.3 12L12 12.9V13.5" />
          <circle cx="12" cy="16.8" r="1.3" fill="#000" stroke="none" />
        </g>
      </mask>
      <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Icon>
  )
}
