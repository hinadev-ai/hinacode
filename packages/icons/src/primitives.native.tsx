import { createContext, use, type ReactNode } from "react"
import { Platform } from "react-native"
import NativeSvg, {
  Circle as NativeCircle,
  type CircleProps,
  G,
  Mask,
  Path as NativePath,
  type PathProps,
  Rect as NativeRect,
  type RectProps,
} from "react-native-svg"

export type IconProps = {
  readonly size?: number
  readonly color: string
  readonly sun?: string
}
export type IconComponent = (props: IconProps) => ReactNode

export const iconAttributes = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2.4,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

export const sun = "hinacode:sun"

const SunColor = createContext("currentColor")

const hidden =
  Platform.OS === "web"
    ? { "aria-hidden": true }
    : { accessibilityElementsHidden: true, importantForAccessibility: "no" as const }

const unshrinkable = { flexShrink: 0 }

export function Svg({
  size = 16,
  color,
  sun: sunColor = color,
  children,
}: IconProps & { readonly children?: ReactNode; readonly "aria-hidden"?: boolean }) {
  return (
    <SunColor value={sunColor}>
      <NativeSvg {...iconAttributes} width={size} height={size} color={color} style={unshrinkable} {...hidden}>
        {children}
      </NativeSvg>
    </SunColor>
  )
}

function useSunFill<P extends { fill?: unknown }>(props: P): P {
  const sunColor = use(SunColor)
  return props.fill === sun ? { ...props, fill: sunColor } : props
}

export function Path(props: PathProps) {
  return <NativePath {...useSunFill(props)} />
}

export function Circle(props: CircleProps) {
  return <NativeCircle {...useSunFill(props)} />
}

export function Rect(props: RectProps) {
  return <NativeRect {...useSunFill(props)} />
}

export { G, Mask }
