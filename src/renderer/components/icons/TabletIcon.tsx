import { Icon, type IconProps } from "./Icon.tsx"

export function TabletIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="3" width="15" height="18" rx="3" />
      <circle cx="12" cy="17.5" r="1.25" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
