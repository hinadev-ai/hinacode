import { Icon, type IconProps } from "./Icon.tsx"

export function NoteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h7ZM14 19.5V17a3 3 0 0 1 3-3h2.5M8 9h8M8 12.5h4" />
    </Icon>
  )
}
