import { Icon, type IconProps } from "./Icon.tsx"

export function CursorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5v15l4-3.7 2.7 5.7 2.6-1.2-2.7-5.6H18Z" />
    </Icon>
  )
}
