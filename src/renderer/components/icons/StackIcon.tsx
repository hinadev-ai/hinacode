import { Icon, type IconProps } from "./Icon.tsx"

export function StackIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4l8.5 4.5L12 13 3.5 8.5ZM3.5 13.5L12 18l8.5-4.5" />
    </Icon>
  )
}
