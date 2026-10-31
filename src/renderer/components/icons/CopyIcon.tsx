import { Icon, type IconProps } from "./Icon.tsx"

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.5 6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5" />
      <rect x="8.5" y="8.5" width="12" height="12" rx="3" />
    </Icon>
  )
}
