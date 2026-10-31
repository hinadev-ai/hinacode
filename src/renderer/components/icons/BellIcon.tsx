import { Icon, type IconProps } from "./Icon.tsx"

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5M4 16.5h16" />
      <circle cx="12" cy="20" r="1.75" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
