import { Icon, type IconProps } from "./Icon.tsx"

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5h16M9.5 6.5V5a2 2 0 0 1 2-2h1a2 2 0 0 1 2 2v1.5M6 9.5V18a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V9.5M10 12v5M14 12v5" />
    </Icon>
  )
}
