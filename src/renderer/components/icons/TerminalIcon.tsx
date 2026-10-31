import { Icon, type IconProps } from "./Icon.tsx"

export function TerminalIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h12a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <path d="M7.5 9.5l2.5 2.5-2.5 2.5" />
      <rect x="13" y="9.5" width="3.5" height="5" rx="1" fill="var(--sun, currentColor)" stroke="none" />
    </Icon>
  )
}
