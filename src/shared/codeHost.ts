import { parseGitHubPullRequestUrl } from "./github.ts"

export type CodeHost = "github" | "gitlab"

export interface PullRequestUrl {
  readonly host: CodeHost
  readonly url: string
}

export interface RemoteProject {
  readonly hostname: string
  readonly path: string
}

export interface GitLabMergeRequest extends RemoteProject {
  readonly iid: number
}

const SEGMENT = /^[\w.-]+$/
const isProjectPath = (path: string) => {
  const segments = path.split("/")
  return segments.length >= 2 && segments.every((segment) => SEGMENT.test(segment) && !/^\.+$/.test(segment))
}

export const parseGitLabMergeRequestUrl = (raw: string): GitLabMergeRequest | undefined => {
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined
  const match = /^\/(.+?)\/-\/merge_requests\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname)
  if (!match) return undefined
  const [, path = "", iid] = match
  if (!isProjectPath(path)) return undefined
  return { hostname: url.host, path, iid: Number(iid) }
}

export const gitLabMergeRequestUrl = ({ hostname, path, iid }: GitLabMergeRequest) =>
  `https://${hostname}/${path}/-/merge_requests/${iid}`

export const parsePullRequestUrl = (raw: string): PullRequestUrl | undefined => {
  const text = raw.trim()
  const github = parseGitHubPullRequestUrl(text)
  if (github) return { host: "github", url: github }
  const gitlab = parseGitLabMergeRequestUrl(text)
  return gitlab ? { host: "gitlab", url: gitLabMergeRequestUrl(gitlab) } : undefined
}

export const codeHostOfUrl = (url: string): CodeHost | undefined => parsePullRequestUrl(url)?.host

const SSH_REMOTE = /^(?:ssh|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/
const SCP_REMOTE = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/

const remoteParts = (remote: string): readonly [string, string] | undefined => {
  if (/^https?:\/\//.test(remote)) {
    if (!URL.canParse(remote)) return undefined
    const url = new URL(remote)
    return [url.host, url.pathname.slice(1)]
  }
  const match = SSH_REMOTE.exec(remote) ?? SCP_REMOTE.exec(remote)
  return match ? [match[1] ?? "", match[2] ?? ""] : undefined
}

export const parseRemote = (remote: string): RemoteProject | undefined => {
  const parts = remoteParts(remote.trim())
  if (!parts) return undefined
  const hostname = parts[0].toLowerCase()
  const path = parts[1].replace(/\/+$/, "").replace(/\.git$/, "")
  return hostname !== "" && isProjectPath(path) ? { hostname, path } : undefined
}

export const pullRequestNumberLabel = (host: CodeHost | undefined, number: number) =>
  `${host === "gitlab" ? "!" : "#"}${number}`

export const codeHostName = (host: CodeHost | undefined) => (host === "gitlab" ? "GitLab" : "GitHub")
