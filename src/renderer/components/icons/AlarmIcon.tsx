import { Icon, type IconProps } from "./Icon.tsx"

export function AlarmIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M3.5 6.5l3-3M20.5 6.5l-3-3" />
      <path d="M12 9V13l2.5 1.5" />
      <circle cx="12" cy="13" r="1.6" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
