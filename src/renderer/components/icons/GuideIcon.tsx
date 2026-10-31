import { Icon, type IconProps } from "./Icon.tsx"

export function GuideIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5v19M12 4.5h6l2.75 2.75L18 10h-6M12 12.5H6l-2.75 2.75L6 18h6" />
    </Icon>
  )
}
