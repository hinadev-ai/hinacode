import { Icon, type IconProps } from "./Icon.tsx"

export function UndoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4.5L4.5 9 9 13.5M4.5 9H14a5.5 5.5 0 0 1 0 11h-4" />
    </Icon>
  )
}
