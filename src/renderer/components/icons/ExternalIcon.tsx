import { Icon, type IconProps } from "./Icon.tsx"

export function ExternalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19.5 13.5V17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3h3.5M14 4h6v6M20 4l-8.5 8.5" />
    </Icon>
  )
}
