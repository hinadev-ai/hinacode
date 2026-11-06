import type { PullRequestDetail } from "./domain.ts"

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

export const addressReviewPrompt = (pullRequest: PullRequestDetail) =>
  [
    `A reviewer requested changes on ${pullRequest.url}.`,
    `Read every review comment and inline thread (\`gh pr view ${pullRequest.url} --comments\`), address each one on ${pullRequest.headRef}, verify locally, and push.`,
    "Then reply on each thread with what changed.",
  ].join(" ")

export const resolveConflictsPrompt = (pullRequest: PullRequestDetail) =>
  [
    `${pullRequest.url} has merge conflicts with ${pullRequest.baseRef}.`,
    `Fetch origin, merge origin/${pullRequest.baseRef} into ${pullRequest.headRef}, and resolve the conflicts so both sides keep their intent.`,
    "Run the project's checks, then push.",
  ].join(" ")
