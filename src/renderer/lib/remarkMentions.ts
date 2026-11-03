import { MENTION } from "../../shared/mentions.ts"

interface MdastNode {
  type: string
  value?: string
  children?: Array<MdastNode>
  data?: { hName: string; hProperties: Record<string, string> }
}

const SKIPPED = new Set(["link", "linkReference", "definition"])

const mentionNodes = (text: string): Array<MdastNode> => {
  const nodes: Array<MdastNode> = []
  let end = 0
  for (const match of text.matchAll(MENTION)) {
    if (match.index > end) nodes.push({ type: "text", value: text.slice(end, match.index) })
    nodes.push({
      type: "mention",
      data: { hName: "span", hProperties: { dataMention: match[0] } },
      children: [{ type: "text", value: match[0] }],
    })
    end = match.index + match[0].length
  }
  if (end < text.length) nodes.push({ type: "text", value: text.slice(end) })
  return nodes
}

const linkMentions = (node: MdastNode) => {
  if (!node.children || SKIPPED.has(node.type)) return
  node.children = node.children.flatMap((child): Array<MdastNode> => {
    if (child.type !== "text") {
      linkMentions(child)
      return [child]
    }
    return mentionNodes(child.value ?? "")
  })
}

export const remarkMentions = () => (tree: MdastNode) => linkMentions(tree)
