# Pull request labels, assignees and reviewers

Status: Building
Date: 2026-11-07

## Problem

An agent opens a pull request, and the developer reviews it in the PR tab. To ask a teammate for review, assign it, or add a label, they leave HinaCode for github.com. The PR tab also hides who has already approved.

## User flow

1. Every pull request shows three rows between its header and the Info, Changes and Guide tabs: Reviewers, Assignees and Labels. They stay visible on every tab. A row with nothing in it reads None.
2. Reviewers show their state. Awaiting review, approved, requested changes or commented.
3. Clicking a row opens a picker with a search box that has focus. Typing filters, the arrow keys move, Enter toggles the highlighted entry, Escape closes.
4. Each toggle applies at once. The row shows the change immediately and settles when GitHub's read comes back. A failure shows under the row and the row reverts.

## Design

- `PullRequestDetail` gains `labels`, `assignees` and `reviewers`, read in the same batched GraphQL query as the rest of the detail. `reviewers` merges `reviewRequests` (state `requested`, users and teams) with `latestReviews` (approved, changes requested, commented), without the author. A requested reviewer who reviewed before shows as requested, matching GitHub's re-request.
- `github.pullRequestCandidates` reads the repository's labels and assignable users (first 100 each). The renderer loads it only when a picker opens.
- `github.editPullRequest({ url, edit: { field, add, remove } })` runs `gh pr edit` with `--add-label=`, `--remove-assignee=` and the rest, looked up from one table keyed by field. The `=` form keeps a value that starts with `-` from reading as a flag. It goes through `ghWrite`, so the detail is read again and the renderer refreshes on the `github.pullRequest` push.
- The picker is a Base UI `Combobox` with `multiple`, inline in a `Popover`, the same pattern as the model picker.

## Out of scope

- Creating labels. Pick from the ones the repository has.
- Team reviewers as picker options. An existing team request shows and can be removed.
- Milestones and projects.
- Repositories with more than 100 labels or assignable users show the first 100.

## Verification

- `GitHub.test.ts` covers the read mapping and the `gh pr edit` arguments.
- In the real app, open a pull request, add and remove a label, an assignee and a reviewer, and check the result with `gh pr view`.
