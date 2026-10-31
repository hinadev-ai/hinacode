import { Icon, type IconProps } from "./Icon.tsx"

export function HomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 10.5L12 4l8 6.5V18a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 18ZM10 20.5V16a2 2 0 0 1 4 0v4.5" />
    </Icon>
  )
}
