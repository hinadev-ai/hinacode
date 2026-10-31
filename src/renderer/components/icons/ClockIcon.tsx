import { Icon, type IconProps } from "./Icon.tsx"

export function ClockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7V12l3.5 2" />
      <circle cx="12" cy="12" r="1.75" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
