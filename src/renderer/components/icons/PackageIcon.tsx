import { Icon, type IconProps } from "./Icon.tsx"

export function PackageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l8 4v10l-8 4-8-4V7ZM4 7l8 4 8-4M12 11v10" />
    </Icon>
  )
}
