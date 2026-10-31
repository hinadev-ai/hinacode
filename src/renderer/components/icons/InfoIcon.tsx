import { Icon, type IconProps } from "./Icon.tsx"

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="8" r="1.4" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M12 11v5.5" />
    </Icon>
  )
}
