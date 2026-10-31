import { Icon, type IconProps } from "./Icon.tsx"

export function MergeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="6" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="18" cy="13" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M6 5v14M6 7.5a5.5 5.5 0 0 0 5.5 5.5H18" />
    </Icon>
  )
}
