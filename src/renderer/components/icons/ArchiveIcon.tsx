import { Icon, type IconProps } from "./Icon.tsx"

export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="5" rx="2.5" />
      <path d="M5 9v8a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9M10 13h4" />
    </Icon>
  )
}
