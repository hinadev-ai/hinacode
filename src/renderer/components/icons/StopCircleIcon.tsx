import { Icon, type IconProps } from "./Icon.tsx"

export function StopCircleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path
        d="M10 9h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  )
}
