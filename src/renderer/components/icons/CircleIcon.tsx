import { Icon, type IconProps } from "./Icon.tsx"

export function CircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
    </Icon>
  )
}
