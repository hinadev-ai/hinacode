import type { PullRequestDetail } from "./domain.ts"

/** What the PR tab sends into the thread so its agent fixes the failing checks. */
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

/** What the PR tab sends into the thread so its agent resolves the merge conflicts. */
export const resolveConflictsPrompt = (pullRequest: PullRequestDetail) =>
  [
    `${pullRequest.url} has merge conflicts with ${pullRequest.baseRef}.`,
    `Fetch origin, merge origin/${pullRequest.baseRef} into ${pullRequest.headRef}, and resolve the conflicts so both sides keep their intent.`,
    "Run the project's checks, then push.",
  ].join(" ")
