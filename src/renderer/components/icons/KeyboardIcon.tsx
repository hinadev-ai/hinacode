import { Icon, type IconProps } from "./Icon.tsx"

export function KeyboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <path d="M7 9.5v0M12 9.5v0M17 9.5v0M8 14.5h8" />
    </Icon>
  )
}
