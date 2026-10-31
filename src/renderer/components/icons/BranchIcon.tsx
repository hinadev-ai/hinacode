import { Icon, type IconProps } from "./Icon.tsx"

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="7" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="17" cy="6" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M7 5v14M17 6v3a6 6 0 0 1-6 6H7" />
    </Icon>
  )
}
