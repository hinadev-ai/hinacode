import { Icon, type IconProps } from "./Icon.tsx"

export function PulseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12h3.5l2.5-6 4 12 2.5-6H21" />
    </Icon>
  )
}
