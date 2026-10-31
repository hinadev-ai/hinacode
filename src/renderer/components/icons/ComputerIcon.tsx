import { Icon, type IconProps } from "./Icon.tsx"

export function ComputerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4h12a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z" />
      <path d="M12 16v4M8 20h8" />
    </Icon>
  )
}
