import { Icon, type IconProps } from "./Icon.tsx"

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path
        d="M9 6h6a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  )
}
