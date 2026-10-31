import { Icon, type IconProps } from "./Icon.tsx"

/** Marks an agent skill: a box with its lid tilted open. */
export function SkillIcon(props: IconProps) {
  return (
    <Icon aria-hidden {...props}>
      <path d="M4.5 7.5 11 2l8.5 2.5L13 10Z" fill="currentColor" />
      <path d="M4 11v6l8 4 8-4v-6M4 11l8 4 8-4M12 15v6" />
    </Icon>
  )
}
