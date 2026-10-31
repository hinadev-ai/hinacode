import { Icon, type IconProps } from "./Icon.tsx"

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7.5 3v5.5a8.5 8.5 0 0 1-7.5 9.5 8.5 8.5 0 0 1-7.5-9.5V6ZM9 12l2 2 4-4" />
    </Icon>
  )
}
