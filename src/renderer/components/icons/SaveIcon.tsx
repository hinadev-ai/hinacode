import { Icon, type IconProps } from "./Icon.tsx"

export function SaveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <path d="M7.5 20v-4.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2V20M8 4v3h6" />
    </Icon>
  )
}
