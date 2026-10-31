import { Icon, type IconProps } from "./Icon.tsx"

export const slashIconShape = (
  <>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <path d="M14.5 7.5l-5 9" />
  </>
)

export function SlashIcon(props: IconProps) {
  return <Icon {...props}>{slashIconShape}</Icon>
}
