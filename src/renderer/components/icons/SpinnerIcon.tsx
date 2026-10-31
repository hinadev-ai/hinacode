import { Icon, type IconProps } from "./Icon.tsx"

export function SpinnerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" opacity=".2" />
      <path d="M12 3.5A8.5 8.5 0 0 1 18.51 17.46" />
      <circle cx="18.51" cy="17.46" r="2.25" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
