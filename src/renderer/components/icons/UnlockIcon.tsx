import { Icon, type IconProps } from "./Icon.tsx"

export function UnlockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 13.5a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z" />
      <path d="M8 10.5V8a4 4 0 0 1 7.8-1.3" />
      <circle cx="12" cy="15.5" r="1.5" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
