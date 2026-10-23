# Pull request code and guide

Status: Shipped
Date: 2026-10-23

## Problem

An agent opens a pull request and the developer has to review it. The PR tab shows the title, checks and description, but not the code. To read the change the developer leaves for GitHub, where the files come in path order. A change that touches twelve files for two reasons reads as twelve unrelated diffs.

[pulls.review](https://github.com/antfu/pulls.review) solves the second half. A model groups the changed files by intent, explains each group, and flags what needs care. It runs on demand, so the reviewer waits a minute or more after asking.

## User flow

1. The PR tab has two tabs, Info and Code. Info is the tab as it was.
2. Code lists the changed files with their line counts. A file expands into its diff.
3. A switch above the list picks Files or Guide. The choice is remembered.
4. Guide shows a summary of the pull request, then the groups in review order. Each group has a category icon, a label, a summary and its files. Notes sit on the files and lines they explain, and critical ones are marked.
5. The guide is usually ready when the developer opens it, because HinaCode wrote it in the background when the pull request was linked or pushed. While a guide for the latest commit is being written, an older guide stays readable and says it is out of date.
6. Settings, Models, Pull request guide picks the Claude model and effort. The default is Sonnet 5.5 at high effort.

## Design

- **Diff.** `github.pullRequestDiff` runs `gh pr diff <url>` and splits it per file. Each file is parsed by `@pulls.review/core/patch-parser` for its status, rename and counts, and keeps its own patch text for `PatchDiff`.
- **Analysis.** We use `@pulls.review/core/llm` for the prompt (`buildAnalysisPrompt`, `buildCliAgentSystemPrompt`), the answer schema (`analysisJsonSchema`) and the reconciliation (`toGroupedResult`). The model runs through the Claude Agent SDK `query()` with `outputFormat: { type: "json_schema" }`, like `ThreadNaming`. The patch is written to a temp directory that is the query's `cwd`, and the only tools are `Read`, `Grep` and `Glob`, so a diff too large to inline can still be read. Electron-vite bundles the package and tree-shakes the agent runtime and model SDKs out of it.
- **Service.** `PullRequestGuides` holds one rule. When main learns a pull request's head, a guide for that head exists or is on its way. It learns heads from a sweep every 3 minutes over the open pull requests linked to unarchived threads, and from every `github.pullRequestDetail` call. At most one analysis runs at a time. A failed head is not retried until the next head or a restart, so a broken pull request cannot spend tokens in a loop.
- **Storage.** Table `pull_request_guide (url PRIMARY KEY, guide)`, one row per pull request holding the newest finished guide as JSON. Running and failed jobs live in memory, because they die with the process.
- **Live state.** `github.pullRequestGuide` returns `{ guide, job }`. Every change is pushed as `pullRequest.guide`, and the renderer keeps them in a store like `usePullRequests`.
- **Settings.** `Settings.pullRequestGuide: { model, effort }`, per environment, so a cloud writes guides with its own login.
- **Trust.** The diff comes from GitHub and goes to a model with read-only tools in a temp directory. The answer is decoded with an Effect schema before it is stored or sent to the renderer.

## Out of scope

- Review comments and approvals. GitHub stays the place to submit a review.
- Chat about the guide. The thread's agent is already there to ask.
- Pull requests that `gh pr diff` refuses (over 300 files or 20,000 lines). The Code tab says so.
- Guides for pull requests no thread links, unless the developer opens them in the PR tab.

## Verification

- `GitHub.test.ts` splits a real `git diff` into files.
- `PullRequestGuides.integration.test.ts` fakes the SDK `query` like `ThreadNaming` does and checks that a head is analyzed once, stored, pushed, and not retried after a failure.
- `pullRequestGuide.test.ts` checks how the renderer matches guide groups to the live diff: moved files, files the guide misses, and line notes outside any hunk.
- With `verify-hinacode`, link a real pull request to a thread, wait for the guide, and screenshot Files and Guide.
