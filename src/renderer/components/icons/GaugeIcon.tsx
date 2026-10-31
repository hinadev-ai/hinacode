import { Icon, type IconProps } from "./Icon.tsx"

export function GaugeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5.49 18.46A8.5 8.5 0 1 1 18.51 18.46" />
      <path d="M12 13l3.5-4" />
      <circle cx="12" cy="13" r="2" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
