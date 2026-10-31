import { Icon, type IconProps } from "./Icon.tsx"

export function RotateIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15.75 5.5A7.5 7.5 0 1 1 8.25 5.5" />
      <path d="M19.13 4.6L15.75 5.5L16.66 8.89" />
    </Icon>
  )
}
