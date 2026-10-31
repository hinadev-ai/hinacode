import { useId } from "react"

import { Icon, type IconProps } from "./Icon.tsx"

export function ToolsIcon(props: IconProps) {
  const id = useId()
  return (
    <Icon {...props}>
      <mask id={`${id}a`} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
        <rect width="24" height="24" fill="#fff" />
        <path d="M13.98 10.02L5 19" stroke="#000" strokeWidth="5.5" strokeLinecap="round" />
      </mask>
      <g mask={`url(#${id}a)`}>
        <rect x="3.5" y="5.6" width="7" height="3.8" rx="1.9" transform="rotate(-45 7 7.5)" />
        <path d="M8.5 9L19 19.5" />
      </g>
      <path d="M20.08 6.13L18.69 7.52A1.56 1.56 0 0 1 16.48 5.31L17.87 3.92A3.7 3.7 0 1 0 20.08 6.13ZM13.98 10.02L5 19" />
    </Icon>
  )
}
