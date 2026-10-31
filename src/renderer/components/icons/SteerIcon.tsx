import { Icon, type IconProps } from "./Icon.tsx"

export function SteerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 14.8L12 19M9.58 10.6L5.94 8.5M14.42 10.6L18.06 8.5" />
      <circle cx="12" cy="12" r="2" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
