import { Icon, type IconProps } from "./Icon.tsx"

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.22 5.85A2.3 2.3 0 1 1 13.78 5.85A6.4 6.4 0 0 1 16.43 7.38A2.3 2.3 0 1 1 18.21 10.47A6.4 6.4 0 0 1 18.21 13.53A2.3 2.3 0 1 1 16.43 16.62A6.4 6.4 0 0 1 13.78 18.15A2.3 2.3 0 1 1 10.22 18.15A6.4 6.4 0 0 1 7.57 16.62A2.3 2.3 0 1 1 5.79 13.53A6.4 6.4 0 0 1 5.79 10.47A2.3 2.3 0 1 1 7.57 7.38A6.4 6.4 0 0 1 10.22 5.85Z" />
      <circle cx="12" cy="12" r="2.5" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
