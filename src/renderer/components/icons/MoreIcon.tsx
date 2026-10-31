import { Icon, type IconProps } from "./Icon.tsx"

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="12" r="2" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="12" cy="12" r="2" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="19" cy="12" r="2" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
