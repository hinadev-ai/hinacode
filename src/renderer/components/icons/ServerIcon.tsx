import { Icon, type IconProps } from "./Icon.tsx"

export function ServerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4" width="17" height="7" rx="3" />
      <rect x="3.5" y="13" width="17" height="7" rx="3" />
      <circle cx="7.5" cy="7.5" r="1.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="7.5" cy="16.5" r="1.25" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
