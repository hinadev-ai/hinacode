import { Icon, type IconProps } from "./Icon.tsx"

export function SnoozeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M3.5 6.5l3-3M20.5 6.5l-3-3" />
      <path d="M10 10.5h4l-4 5h4" />
    </Icon>
  )
}
