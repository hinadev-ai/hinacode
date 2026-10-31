import { Icon, type IconProps } from "./Icon.tsx"

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="16" r="4" />
      <path d="M10.9 13.1L19 5M16.5 7.5l2 2M14 10l1.5 1.5" />
    </Icon>
  )
}
