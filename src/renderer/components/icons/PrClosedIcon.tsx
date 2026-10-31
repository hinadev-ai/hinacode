import { Icon, type IconProps } from "./Icon.tsx"

export function PrClosedIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="6" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="18" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M6 5v14M18 19v-5M15.5 4.5l5 5M20.5 4.5l-5 5" />
    </Icon>
  )
}
