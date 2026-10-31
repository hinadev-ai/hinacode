import { Icon, type IconProps } from "./Icon.tsx"

export function MinusCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </Icon>
  )
}
