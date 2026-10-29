import { Schema } from "effect"

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/

export const GitHubRepository = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(OWNER)),
  name: Schema.String.check(Schema.isPattern(NAME)),
})
export type GitHubRepository = typeof GitHubRepository.Type

const CLONE_COMMAND = /^(?:git\s+clone|gh\s+repo\s+clone)\s+/
const URL_FORMS = [
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/,
  /^git@github\.com:([^/]+)\/([^/]+)$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  /^([^/]+)\/([^/]+)$/,
]

export function parseGitHubRepository(input: string): GitHubRepository | null {
  const text = input.trim().replace(CLONE_COMMAND, "")
  for (const form of URL_FORMS) {
    const match = form.exec(text)
    if (!match) continue
    const owner = match[1] ?? ""
    const name = (match[2] ?? "").replace(/\.git$/, "")
    return OWNER.test(owner) && NAME.test(name) ? { owner, name } : null
  }
  return null
}

export const parseGitHubPullRequestUrl = (raw: string): string | undefined => {
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== "https:" || (url.hostname !== "github.com" && url.hostname !== "www.github.com"))
    return undefined
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/.*)?$/.exec(url.pathname)
  if (!match) return undefined
  const [, owner, repo, number] = match
  return `https://github.com/${owner}/${repo}/pull/${number}`
}

export function parsePullRequestSelector(input: string): string | undefined {
  const text = input.trim()
  const number = /^#?([1-9]\d*)$/.exec(text)?.[1]
  return number ?? parseGitHubPullRequestUrl(text)
}

export const PullRequestSelector = Schema.String.check(
  Schema.makeFilter((text) => parsePullRequestSelector(text) === text || "a pull request number or URL"),
)

const GITHUB_PULL_REQUEST = /^https:\/\/github\.com\/(?=[^/]+\/[^/]+\/pull\/\d+)/i

export const linearReviewUrl = (url: string) => url.replace(GITHUB_PULL_REQUEST, "https://linear.review/")
