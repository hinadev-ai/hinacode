import { Icon, type IconProps } from "./Icon.tsx"

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="14.5" cy="9.5" r="4.5" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M11.3 12.7L5 19" />
    </Icon>
  )
}
