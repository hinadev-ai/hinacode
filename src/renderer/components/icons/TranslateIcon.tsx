import { Icon, type IconProps } from "./Icon.tsx"

export function TranslateIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.5h8M7.5 3.5v2M5 5.5a8 8 0 0 0 5 6M10 5.5a8 8 0 0 1-5.5 6.5M12.5 20.5l4-9 4 9M13.8 17.5h5.4" />
    </Icon>
  )
}
