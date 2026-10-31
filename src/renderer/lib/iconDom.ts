import { isValidElement, type ReactElement, type ReactNode } from "react"

const SVG = "http://www.w3.org/2000/svg"

const attributeName = (prop: string) =>
  prop === "className"
    ? "class"
    : prop === "viewBox"
      ? prop
      : prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

// FIXME: only react-icons glyphs can be called outside a render; the React Compiler gives our own components a hook
export function iconDom(element: ReactElement): Element {
  const { children, attr, ...props } = element.props as Record<string, unknown>
  if (typeof element.type === "function" && attr === undefined) {
    const rendered: ReactNode = (element.type as (props: unknown) => ReactNode)(element.props)
    if (isValidElement(rendered)) return iconDom(rendered)
  }
  const node = document.createElementNS(SVG, typeof element.type === "string" ? element.type : "svg")
  for (const [name, value] of Object.entries({ ...(attr as object | undefined), ...props }))
    if (value !== undefined && value !== false) node.setAttribute(attributeName(name), String(value))
  for (const child of [children].flat()) if (isValidElement(child)) node.append(iconDom(child))
  return node
}
