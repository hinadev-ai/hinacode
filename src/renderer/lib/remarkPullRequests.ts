import type { GitHubRepository } from "../../shared/github.ts"
import { linkPullRequestNumbers } from "./pullRequestRefs.ts"

interface MdastNode {
  type: string
  value?: string
  url?: string
  children?: Array<MdastNode>
}

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

export const remarkPullRequests = (repository: GitHubRepository) => () => (tree: MdastNode) =>
  linkNumbers(tree, repository)
