import { Icon, type IconProps } from "./Icon.tsx"

export function PullRequestIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="5" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="6" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <circle cx="18" cy="19" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
      <path d="M6 5v14M18 19V10a3 3 0 0 0-3-3h-4.5" />
      <path d="M13 4.5L10.5 7 13 9.5" />
    </Icon>
  )
}
