import { Icon, type IconProps } from "./Icon.tsx"

export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 14V3.5M7.5 8L12 3.5 16.5 8M4 16.5v.5a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-.5" />
    </Icon>
  )
}
