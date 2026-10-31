import rehypeRaw from "rehype-raw"
import rehypeSanitize, { defaultSchema } from "rehype-sanitize"

interface HastNode {
  type: string
  children?: Array<HastNode>
}

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.["img"] ?? []), "srcSet", "sizes"],
    source: [...(defaultSchema.attributes?.["source"] ?? []), "sizes"],
  },
}

type HastTransform = (tree: HastNode, file?: unknown) => HastNode

const parseRaw = rehypeRaw() as unknown as HastTransform
const sanitize = rehypeSanitize(schema) as unknown as HastTransform

const hasRawNode = (root: HastNode) => {
  const stack: Array<HastNode> = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.type === "raw") return true
    if (node.children) stack.push(...node.children)
  }
  return false
}

export const rehypeEmbeddedHtml = () => (tree: HastNode, file?: unknown) =>
  hasRawNode(tree) ? sanitize(parseRaw(tree, file), file) : tree

export type RehypeEmbeddedHtml = typeof rehypeEmbeddedHtml
