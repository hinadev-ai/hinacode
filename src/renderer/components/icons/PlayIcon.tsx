import { Icon, type IconProps } from "./Icon.tsx"

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M10.5 9l4.5 3-4.5 3Z" fill="currentColor" />
    </Icon>
  )
}
