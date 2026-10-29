import type { PullRequestComment, PullRequestDetail } from "./domain.ts"

export const fixChecksPrompt = (pullRequest: PullRequestDetail) => {
  const failing = pullRequest.checkRuns
    .filter((run) => run.status === "failing")
    .map((run) => `- ${run.name}${run.url ? `: ${run.url}` : ""}`)
  return [
    `CI is failing on ${pullRequest.url} (branch ${pullRequest.headRef}). Failing checks:`,
    ...failing,
    "",
    "Read the failing logs (for GitHub Actions, `gh run view <run-id> --log-failed`), find the root cause, fix it, verify locally, and push.",
  ].join("\n")
}

export const resolveConflictsPrompt = (pullRequest: PullRequestDetail) =>
  [
    `${pullRequest.url} has merge conflicts with ${pullRequest.baseRef}.`,
    `Fetch origin, merge origin/${pullRequest.baseRef} into ${pullRequest.headRef}, and resolve the conflicts so both sides keep their intent.`,
    "Run the project's checks, then push.",
  ].join(" ")

export const addressCommentPrompt = (
  pullRequest: PullRequestDetail,
  { author, body, url, location }: PullRequestComment,
) => {
  const where = location ? ` on ${location.path}${location.line === null ? "" : `:${location.line}`}` : ""
  return [
    `@${author} commented${where} on ${pullRequest.url} (${url}):`,
    "",
    ...body.split("\n").map((line) => `> ${line}`),
    "",
    "Address this comment. If it asks for a change, make it, verify it, and push. If you disagree, reply with why instead.",
  ].join("\n")
}
