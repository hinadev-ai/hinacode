import { Icon, type IconProps } from "./Icon.tsx"

export function CollapseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h16M8.5 4.5L12 8l3.5-3.5M8.5 19.5L12 16l3.5 3.5" />
    </Icon>
  )
}
