import { Icon, type IconProps } from "./Icon.tsx"

export function FullscreenExitIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 4v2a3 3 0 0 1-3 3H4M20 9h-2a3 3 0 0 1-3-3V4M15 20v-2a3 3 0 0 1 3-3h2M4 15h2a3 3 0 0 1 3 3v2" />
    </Icon>
  )
}
