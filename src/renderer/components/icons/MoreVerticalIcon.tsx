import { Icon, type IconProps } from "./Icon.tsx"

export function MoreVerticalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="5" r="2" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="12" cy="12" r="2" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="12" cy="19" r="2" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
