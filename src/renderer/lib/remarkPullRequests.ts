import type { GitHubRepository } from "../../shared/github.ts"
import { linkPullRequestNumbers } from "./pullRequestRefs.ts"

/** The part of an mdast node this plugin reads; mdast's types are not a direct dependency. */
interface MdastNode {
  type: string
  value?: string
  url?: string
  children?: Array<MdastNode>
}

// Text inside these is already a link; code is never a `text` node, so it is skipped without listing it.
const LINKED = new Set(["link", "linkReference", "definition"])

const linkNumbers = (node: MdastNode, repository: GitHubRepository) => {
  if (!node.children || LINKED.has(node.type)) return
  node.children = node.children.flatMap((child): Array<MdastNode> => {
    if (child.type !== "text") {
      linkNumbers(child, repository)
      return [child]
    }
    const segments = linkPullRequestNumbers(child.value ?? "", repository)
    if (segments.every((segment) => segment.type === "text")) return [child]
    return segments.map((segment) =>
      segment.type === "text"
        ? { type: "text", value: segment.text }
        : { type: "link", url: segment.href, children: [{ type: "text", value: segment.text }] },
    )
  })
}

/** A remark plugin that links `#n` in prose to pull request n of `repository`. */
export const remarkPullRequests = (repository: GitHubRepository) => () => (tree: MdastNode) =>
  linkNumbers(tree, repository)
