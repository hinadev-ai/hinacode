import { Icon, type IconProps } from "./Icon.tsx"

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0ZM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Icon>
  )
}
