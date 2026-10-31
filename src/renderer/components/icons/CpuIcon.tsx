import { Icon, type IconProps } from "./Icon.tsx"

export function CpuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.5" y="5.5" width="13" height="13" rx="3" />
      <path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3" />
      <rect x="10" y="10" width="4" height="4" rx="1" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
