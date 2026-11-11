# GitLab merge requests in the source control tab

Status: Building
Date: 2026-11-09

## Problem

A developer whose code lives on GitLab, on gitlab.com or on their company's own server, gets none of HinaCode's pull request features. `link_pull_request` rejects a merge request URL, the tab stays empty, the watcher never wakes the thread when the pipeline fails, and Create pull request runs `gh pr create` against a remote `gh` cannot talk to. They track every merge request in a browser tab next to the app, which is the context switching HinaCode exists to remove.

## User flow

1. The agent opens a merge request with `glab mr create` and calls `link_pull_request` with its URL, or the developer clicks Create merge request in the tab. Both work the same as on GitHub.
2. The side panel tab, renamed Source control, lists the thread's merge requests next to any pull requests. Each row shows the GitLab mark, `!42` instead of `#42`, the title, the state, the pipeline result, approvals and conflicts.
3. Expanding a row shows the description, one check per pipeline job with a link to its log, and the comments.
4. Merge, Squash and merge, and Close work from the row. Rebase is hidden, because GitLab merges with the method the project is configured for.
5. `watch_pull_request` on a merge request wakes the thread when the pipeline fails or passes, approvals change, the branch conflicts, or the merge request merges or closes.
6. If `glab` is missing or signed out, the row shows the same kind of notice `gh` errors show today, telling the developer which command to run.

## Design

### Which host a URL or a repository belongs to

`src/shared/codeHost.ts` owns one type, `CodeHost = "github" | "gitlab"`, and two pure parsers.

- `parsePullRequestUrl(raw)` returns `{ host, url }` with the canonical URL, or `undefined`. A GitHub URL must be on github.com, as today. A GitLab URL is any https URL whose path is `<namespace>/<project>/-/merge_requests/<iid>`. The `/-/merge_requests/` segment is GitLab's alone, so a self-hosted URL needs no configuration. Namespaces nest (`group/subgroup/project`), so the project path is everything before `/-/`.
- `parseGitLabRemote(remote)` reads `{ hostname, path }` from an https, scp-style or `ssh://` remote.

The URL decides the host for everything that starts from a link: reading, watching, merging, closing and commenting. Nothing stores the host, so `pull_request_link` needs no migration and the mobile app's links work unchanged.

Work that starts from a repository, finding the branch's merge request and creating one, decides from `origin`:

1. `github.com` is GitHub, and `gitlab.com` is GitLab.
2. Any other hostname is GitLab when `glab api --hostname <host> version` answers with 200 or 401. Either status proves a GitLab API is there; 401 means `glab` is signed out, which the developer should be told about rather than have the remote treated as GitHub.
3. Otherwise it stays GitHub, which keeps GitHub Enterprise remotes on `gh` the way they work today.

The probe result is cached per hostname for the life of the process.

### Services

`GitLab.ts` is a service beside `GitHub.ts`. It shells out to `glab api --hostname <host>`, the way `GitHub.ts` shells out to `gh`, so authentication, self-hosted hosts and tokens stay in `glab`'s config and HinaCode stores no GitLab secret. Every response is decoded with a schema.

`SourceControl.ts` is the only thing the rest of main calls for the operations both hosts share: `pullRequest`, `pullRequestDetail`, `pullRequestOpenedAt`, `merge`, `close`, `comment`, `branchPullRequest` and `createPullRequest`. It routes by URL or by `origin` as above. `PullRequests`, `PullRequestWatcher`, `AutoSettle`, `Worktrees` and the `github.*` rpc handlers move from `GitHub` to `SourceControl` for those calls. GitHub-only features keep calling `GitHub` directly.

The rpc method names stay `github.pullRequest`, `github.merge` and so on. The mobile app calls them by name over the relay, and renaming them would break every installed phone for a cosmetic gain.

### Mapping a merge request onto `PullRequest`

| `PullRequest` field          | GitLab source                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number`                     | `iid`                                                                                                                                                                     |
| `status`                     | `merged` is merged, `closed` and `locked` are closed, `opened` with `draft` is draft, else open                                                                           |
| `checks`                     | `head_pipeline.status`: `success` passing; `failed` and `canceled` failing; `skipped`, `manual` and no pipeline null; the rest pending                                    |
| `review`                     | `detailed_merge_status` `requested_changes` is changesRequested; approvals `approved` with at least one approver is approved; `not_approved` is reviewRequired; else null |
| `mergeable`                  | `has_conflicts` is conflicting; `detailed_merge_status` `checking`, `unchecked` or `preparing` is unknown; else mergeable                                                 |
| `author`                     | `author.username`                                                                                                                                                         |
| `headRefName`, `baseRefName` | `source_branch`, `target_branch`                                                                                                                                          |
| `additions`, `deletions`     | `+` and `-` lines in the first 100 files of `/diffs`                                                                                                                      |
| `mergedAt`                   | `merged_at`                                                                                                                                                               |

`PullRequestDetail` adds `description` as `body`, `sha` as `head`, `/diffs`'s `X-Total` as `changedFiles`, one `CheckRun` per job of the head pipeline (a failed job with `allow_failure` counts as skipped), and the non-system notes as comments, with diff notes located by `position.new_path` and `new_line`, or `old_path` and `old_line` on the left side for a removed line. GitLab only serves notes to a signed-in user, so a signed-out read of a public project shows no comments instead of failing.

A comment is "you" when its author matches `GET /user`, read once per host. That read never fails the detail: gitlab.com throttles anonymous `/user` calls for most of an hour after a few 401s, so any error means nobody is "you" until the app restarts.

There is no read cache yet. A summary costs three calls (the merge request, approvals, diffs) and a detail adds notes and jobs, well inside gitlab.com's signed-in budget of 2,000 calls a minute.

### Renderer

The tab's title becomes Source control. A row derives its host from the URL with `parsePullRequestUrl`, then picks the mark (`RiGitlabFill`), the `!` prefix and which merge methods to offer. The review window, line comments and the code tour stay GitHub only; a merge request row opens the merge request on GitLab instead.

## Out of scope

- Reviewing a merge request's diff inside HinaCode, line comments, and the AI code tour. They need `fileContent`, a unified diff and review comment endpoints, a second slice once merge requests are useful in the tab.
- Labels, assignees and reviewers on a merge request. The editor for them calls GitHub-only rpcs, so the tab hides it on merge requests and the mapper returns empty lists.
- GitLab triggers for automations, and GitLab issues. They are pollers with their own design.
- Cloning, creating a repository, and searching merge requests from the composer.
- Bitbucket, Gitea and GitHub Enterprise detection. The host table is two rows on purpose.
- A different SSH and web hostname for one GitLab server. `glab` handles that in its config, and the probe uses the remote's hostname.

## Verification

- `codeHost.test.ts` covers URL and remote parsing, including nested groups, self-hosted hosts, ports and lookalike paths.
- `GitLab.test.ts` maps recorded API responses onto `PullRequest` and `PullRequestDetail`.
- `GitLab.integration.test.ts` reads a real public merge request on gitlab.com through `glab`, signed out, and skips when `glab` is not installed.
- In the real app with `verify-hinacode`, link `https://gitlab.com/gitlab-org/cli/-/merge_requests/<iid>` to a thread and screenshot the tab with the row collapsed and expanded.
