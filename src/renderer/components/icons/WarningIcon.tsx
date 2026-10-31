import { Icon, type IconProps } from "./Icon.tsx"

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5" />
      <circle cx="12" cy="16" r="1.4" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
