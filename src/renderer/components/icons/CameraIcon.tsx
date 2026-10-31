import { Icon, type IconProps } from "./Icon.tsx"

export function CameraIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9a3 3 0 0 1 3-3h1.5l1.5-2h4l1.5 2H17a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Icon>
  )
}
