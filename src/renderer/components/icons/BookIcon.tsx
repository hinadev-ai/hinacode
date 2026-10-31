import { Icon, type IconProps } from "./Icon.tsx"

export function BookIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 7.5A3.5 3.5 0 0 0 8.5 4h-5v14H9a3 3 0 0 1 3 3M12 7.5A3.5 3.5 0 0 1 15.5 4h5v14H15a3 3 0 0 0-3 3M12 7.5V21" />
    </Icon>
  )
}
