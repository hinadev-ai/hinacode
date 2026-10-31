import { Icon, type IconProps } from "./Icon.tsx"

export function PaletteIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a9 9 0 0 0 0 18 2 2 0 0 0 1.5-3.3 2 2 0 0 1 1.5-3.2h2.5a3.5 3.5 0 0 0 3.5-3.5A9 9 0 0 0 12 3Z" />
      <circle cx="7.5" cy="12" r="1.4" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="9.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="7.5" r="1.4" fill="currentColor" stroke="none" />
    </Icon>
  )
}
