import { Icon, type IconProps } from "./Icon.tsx"

export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.75 5.5A7.5 7.5 0 1 1 8.25 5.5" />
      <path d="M7.34 8.89L8.25 5.5L4.87 4.6" />
    </Icon>
  )
}
