import { Icon, type IconProps } from "./Icon.tsx"

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 5a2 2 0 0 1 3.4 0l7 12a2 2 0 0 1-1.7 3H5a2 2 0 0 1-1.7-3ZM12 10v3.5" />
      <circle cx="12" cy="16.6" r="1.3" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
