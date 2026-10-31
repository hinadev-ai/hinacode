import { isValidElement, type ReactNode } from "react"
import { iconAttributes } from "../components/icons/Icon.tsx"

const SVG = "http://www.w3.org/2000/svg"

const attributeName = (prop: string) =>
  prop === "className"
    ? "class"
    : prop === "viewBox"
      ? prop
      : prop.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

const setAttributes = (node: Element, attributes: Record<string, unknown>) => {
  for (const [name, value] of Object.entries(attributes))
    if (value !== undefined && value !== false && name !== "children")
      node.setAttribute(attributeName(name), String(value))
}

const appendShape = (parent: Element, shape: ReactNode) => {
  for (const child of [shape].flat()) {
    if (!isValidElement<Record<string, unknown>>(child)) continue
    if (typeof child.type !== "string") {
      appendShape(parent, child.props["children"] as ReactNode)
      continue
    }
    const node = document.createElementNS(SVG, child.type)
    setAttributes(node, child.props)
    appendShape(node, child.props["children"] as ReactNode)
    parent.append(node)
  }
}

// FIXME: the React Compiler gives our icon components a cache hook, so code outside a render draws their shape instead of calling them
export function iconDom(shape: ReactNode, attributes: Record<string, string>): Element {
  const svg = document.createElementNS(SVG, "svg")
  setAttributes(svg, { ...iconAttributes, ...attributes })
  appendShape(svg, shape)
  return svg
}
