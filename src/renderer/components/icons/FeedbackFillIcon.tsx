import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function FeedbackFillIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <g fill="#fff" stroke="#fff">
          <path d="M8.82 19.38A8.5 8.5 0 1 0 4.79 16L3.6 20.4Z" />
        </g>
        <g stroke="#000" fill="none">
          <path d="M8.5 10h7M8.5 13.5h4" />
        </g>
      </mask>
      <rect width="24" height="24" fill="currentColor" stroke="none" mask={`url(#${id}a)`} />
    </Icon>
  )
}
