import { Icon, type IconProps } from "./Icon.tsx"

export function ShieldKeyholeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7.5 3v5.5a8.5 8.5 0 0 1-7.5 9.5 8.5 8.5 0 0 1-7.5-9.5V6Z" />
      <circle cx="12" cy="10.5" r="2" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M12 12.5v3" />
    </Icon>
  )
}
