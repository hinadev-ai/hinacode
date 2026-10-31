import { Icon, type IconProps } from "./Icon.tsx"

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5l4.5 4.5" />
    </Icon>
  )
}
