import { Icon, type IconProps } from "./Icon.tsx"

export function FlowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="7" height="6" rx="2" />
      <rect x="13.5" y="14.5" width="7" height="6" rx="2" />
      <path d="M7 9.5v2a4 4 0 0 0 4 4h2.5" />
    </Icon>
  )
}
