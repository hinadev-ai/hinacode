import { Icon, type IconProps } from "./Icon.tsx"

export function SidebarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <path d="M9.5 4v16" />
    </Icon>
  )
}
