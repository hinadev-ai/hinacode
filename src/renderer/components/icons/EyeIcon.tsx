import { Icon, type IconProps } from "./Icon.tsx"

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 12a10.6 10.6 0 0 1 19 0a10.6 10.6 0 0 1-19 0Z" />
      <circle cx="12" cy="12" r="3" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
