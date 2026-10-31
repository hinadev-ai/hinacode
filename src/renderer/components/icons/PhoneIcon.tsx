import { Icon, type IconProps } from "./Icon.tsx"

export function PhoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="3" />
      <circle cx="12" cy="18" r="1.25" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
