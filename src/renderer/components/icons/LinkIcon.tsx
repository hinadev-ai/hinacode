import { Icon, type IconProps } from "./Icon.tsx"

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.5 13.5l3-3M9 11.5l-2.5 2.5a3.5 3.5 0 0 0 5 5l2.5-2.5M15 12.5l2.5-2.5a3.5 3.5 0 0 0-5-5L10 7.5" />
    </Icon>
  )
}
