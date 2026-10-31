import { Icon, type IconProps } from "./Icon.tsx"

export function GlobeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 3a11 11 0 0 1 0 18a11 11 0 0 1 0-18ZM3 12h18" />
    </Icon>
  )
}
