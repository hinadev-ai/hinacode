/** The part of an mdast node this plugin reads; mdast's types are not a direct dependency. */
interface MdastNode {
  type: string
  value?: string
  children?: Array<MdastNode>
  data?: { hName?: string }
}

const isTag = (node: MdastNode | undefined, tag: string) => node?.type === "html" && node.value?.toLowerCase() === tag

const wrapKeys = (node: MdastNode) => {
  if (!node.children) return
  const children: Array<MdastNode> = []
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (child === undefined) continue
    const close = isTag(child, "<kbd>") ? node.children.findIndex((next, j) => j > i && isTag(next, "</kbd>")) : -1
    if (close === -1) {
      wrapKeys(child)
      children.push(child)
      continue
    }
    children.push({ type: "kbd", data: { hName: "kbd" }, children: node.children.slice(i + 1, close) })
    i = close
  }
  node.children = children
}

/**
 * A remark plugin that renders `<kbd>…</kbd>` as a key. Raw HTML is otherwise not rendered, so agents can
 * write tags like `<Suspense>` in prose; only this one tag pair is singled out.
 */
export const remarkKbd = () => (tree: MdastNode) => wrapKeys(tree)
