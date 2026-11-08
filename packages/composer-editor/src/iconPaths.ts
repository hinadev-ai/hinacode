import { Children, isValidElement, type ReactNode } from "react"
import type { IconPath } from "./types.ts"

type ShapeProps = Record<string, string | number | undefined> & { children?: ReactNode }

const number = (value: string | number | undefined) => Number(value ?? 0)

const rectPath = ({ x, y, width, height, rx }: ShapeProps) => {
  const [left, top, w, h, r] = [number(x), number(y), number(width), number(height), number(rx)]
  return `M${left + r} ${top}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 -${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1 -${r} -${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r} -${r}z`
}

const circlePath = ({ cx, cy, r }: ShapeProps) => {
  const [x, y, radius] = [number(cx), number(cy), number(r)]
  return `M${x - radius} ${y}a${radius} ${radius} 0 1 0 ${2 * radius} 0a${radius} ${radius} 0 1 0 -${2 * radius} 0z`
}

export function iconPaths(shape: ReactNode): IconPath[] {
  return Children.toArray(shape).flatMap((node): IconPath[] => {
    if (!isValidElement<ShapeProps>(node)) return []
    const { props } = node
    const fill = props.fill !== undefined && props.fill !== "none"
    if (typeof props.d === "string") return [{ d: props.d, fill }]
    if (props.width !== undefined) return [{ d: rectPath(props), fill }]
    if (props.r !== undefined) return [{ d: circlePath(props), fill }]
    return iconPaths(props.children)
  })
}
