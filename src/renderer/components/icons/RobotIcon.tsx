import { Icon, type IconProps } from "./Icon.tsx"

export function RobotIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 5.5V8" />
      <circle cx="12" cy="4" r="1.6" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="9" cy="13.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  )
}
