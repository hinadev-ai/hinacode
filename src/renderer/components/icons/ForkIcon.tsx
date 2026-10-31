import { Icon, type IconProps } from "./Icon.tsx"

export function ForkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="18" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="12" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M6 5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V5M12 10v9" />
    </Icon>
  )
}
