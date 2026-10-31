import { Icon, type IconProps } from "./Icon.tsx"

export function SidebarFillIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <path d="M6 4h3.5v16H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" fill="currentColor" stroke="none" />
    </Icon>
  )
}
