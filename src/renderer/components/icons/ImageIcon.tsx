import { Icon, type IconProps } from "./Icon.tsx"

export function ImageIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <circle cx="8.5" cy="9" r="1.75" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M4 17.5l5-5 7.5 7.5M14 15.5l2.5-2.5 4 4" />
    </Icon>
  )
}
