import { Icon, type IconProps } from "./Icon.tsx"

export function TagIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.5v5.2a2 2 0 0 0 .6 1.4l7.8 7.8a2 2 0 0 0 2.8 0l5.2-5.2a2 2 0 0 0 0-2.8L12.1 4.1a2 2 0 0 0-1.4-.6H5.5a2 2 0 0 0-2 2Z" />
      <circle cx="8" cy="8" r="1.6" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
