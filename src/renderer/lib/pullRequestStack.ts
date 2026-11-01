export interface StackNode {
  readonly url: string
  readonly children: ReadonlyArray<StackNode>
}

interface Branches {
  readonly headRefName: string
  readonly baseRefName: string
}

const repositoryOf = (url: string) => url.slice(0, url.lastIndexOf("/pull/"))

export const pullRequestStacks = (
  urls: ReadonlyArray<string>,
  branches: ReadonlyArray<Branches | undefined>,
): ReadonlyArray<StackNode> => {
  const parentOf = new Map<string, string>()
  urls.forEach((url, index) => {
    const base = branches[index]?.baseRefName
    if (base === undefined) return
    const parent = urls.find(
      (other, otherIndex) =>
        otherIndex !== index && repositoryOf(other) === repositoryOf(url) && branches[otherIndex]?.headRefName === base,
    )
    if (parent !== undefined) parentOf.set(url, parent)
  })
  for (const url of urls) {
    const seen = new Set([url])
    for (let up = parentOf.get(url); up !== undefined; up = parentOf.get(up)) {
      if (seen.has(up)) {
        parentOf.delete(url)
        break
      }
      seen.add(up)
    }
  }
  const node = (url: string): StackNode => ({
    url,
    children: urls.filter((child) => parentOf.get(child) === url).map(node),
  })
  return urls.filter((url) => !parentOf.has(url)).map(node)
}
