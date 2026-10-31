import { Icon, type IconProps } from "./Icon.tsx"

export function QuestionIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.4 9.6A2.7 2.7 0 1 1 13.3 12L12 12.9V13.5" />
      <circle cx="12" cy="16.8" r="1.3" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
