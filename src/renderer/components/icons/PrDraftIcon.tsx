import { Icon, type IconProps } from "./Icon.tsx"

export function PrDraftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="6" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="18" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M6 5v14" />
      <circle cx="18" cy="13" r="1.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="18" cy="8" r="1.25" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
