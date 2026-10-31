import { Icon, type IconProps } from "./Icon.tsx"

export function MarkdownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="3" />
      <path d="M6.5 15V9l2.5 3 2.5-3v6M16 9v6M13.5 12.5L16 15l2.5-2.5" />
    </Icon>
  )
}
