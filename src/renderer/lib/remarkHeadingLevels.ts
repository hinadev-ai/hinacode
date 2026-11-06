interface MdastNode {
  type: string
  depth?: number
  children?: Array<MdastNode>
  data?: { hProperties?: Record<string, unknown> }
}

const collectHeadings = (node: MdastNode, found: Array<MdastNode> = []) => {
  if (node.type === "heading") found.push(node)
  for (const child of node.children ?? []) collectHeadings(child, found)
  return found
}

export const remarkHeadingLevels = () => (tree: MdastNode) => {
  const headings = collectHeadings(tree)
  const shallowest = Math.min(...headings.map((heading) => heading.depth ?? 1))
  for (const heading of headings) {
    const level = Math.min(6, (heading.depth ?? 1) - shallowest + 2)
    heading.data = { ...heading.data, hProperties: { ...heading.data?.hProperties, "aria-level": level } }
  }
}
