import { type GitHubRepository, parseGitHubRepository } from "../../shared/github.ts"
import type { Segment } from "./linkify.ts"

export interface PullRequestRef extends GitHubRepository {
  readonly number: number
}

const PULL_REQUEST_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i

/** The pull request a `https://github.com/<owner>/<repo>/pull/<n>` url points at, or null for any other url. */
export const parsePullRequestUrl = (href: string): PullRequestRef | null => {
  const match = PULL_REQUEST_URL.exec(href)
  const repository = match && parseGitHubRepository(`${match[1]}/${match[2]}`)
  return repository && { ...repository, number: Number(match[3]) }
}

const sameRepository = (a: GitHubRepository, b: GitHubRepository) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase()

/** `#n` for a pull request in the thread's own repository, `owner/repo#n` for any other. */
export const pullRequestLabel = (ref: PullRequestRef, repository: GitHubRepository | null) =>
  repository && sameRepository(ref, repository) ? `#${ref.number}` : `${ref.owner}/${ref.name}#${ref.number}`

const pullRequestUrl = ({ owner, name }: GitHubRepository, number: string) =>
  `https://github.com/${owner}/${name}/pull/${number}`

const NUMBER_REFERENCE = /(?<=^|[\s(])#(\d+)(?!\w)/g

/** Splits text into text and `#n` segments linked to `repository`'s pull request n. */
export const linkPullRequestNumbers = (text: string, repository: GitHubRepository): Array<Segment> => {
  const segments: Array<Segment> = []
  let last = 0
  for (const match of text.matchAll(NUMBER_REFERENCE)) {
    if (match.index > last) segments.push({ type: "text", text: text.slice(last, match.index) })
    segments.push({ type: "link", text: match[0], href: pullRequestUrl(repository, match[1] ?? "") })
    last = match.index + match[0].length
  }
  if (last < text.length) segments.push({ type: "text", text: text.slice(last) })
  return segments
}
