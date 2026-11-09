export const mergeRequest4335 = {
  iid: 4335,
  title: "docs(skills): expand glab-stack guidance for non-interactive reorder and infer",
  description:
    '## Description\n\nFollow-up to https://gitlab.com/gitlab-org/cli/-/merge_requests/4267, which made `glab stack reorder` and `glab stack infer` usable without a TTY. That MR updated the bundled `glab-stack` skill, but agents following the skill could still get stuck or leave GitLab out of sync. This MR fills those gaps:\n\n- **`infer` needs `--name` when no stack is active.** Without it, `infer --all` fails with "no stack found and no TTY available". Rule 6 now says so, and there\'s a new quick-reference row.\n- **`reorder` only rebases locally.** Rule 5 now says to run `glab stack sync` afterwards to force-push.\n- **Reorder conflict recovery.** A new section covers `git rebase --continue` followed by `glab stack reorder --continue` or `--abort`. Both commands are also in the quick reference.\n- **Branch-list rules for `reorder`.** List every branch exactly once, the first branch sits on the base branch, and commit or stash tracked changes first.\n- **Wording.** `reorder` and `infer` without the new arguments now "hang or fail without a TTY", and the skill description mentions inferring a stack from commits.\n\n## Related Issues\n\nRelated to #8658\n\n## How has this been tested?\n\nDocs-only change to `SKILL.md`. The `validate-skills` and markdownlint hooks pass, as do the `internal/commands/skills` tests.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  state: "merged",
  draft: false,
  has_conflicts: false,
  detailed_merge_status: "not_open",
  sha: "0b85b1ab3883569b446d642f29468d03ecb3ffc4",
  web_url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/4335",
  source_branch: "jmc-stack-skill-reorder-infer-followup",
  target_branch: "main",
  merged_at: "2026-11-06T02:14:57.439Z",
  created_at: "2026-11-06T01:59:09.536Z",
  author: {
    username: "jay_mccure",
    bot: false,
  },
  head_pipeline: {
    id: 3034645956,
    status: "success",
    web_url: "https://gitlab.com/gitlab-org/cli/-/pipelines/3034645956",
  },
}

export const approvals4335 = {
  approved: true,
  approved_by: [
    {
      user: {
        username: "GitLabDuo",
      },
    },
    {
      user: {
        username: "gitlab-bot",
      },
    },
  ],
}

export const diffs4335 = [
  {
    diff: "@@ -1,6 +1,6 @@\n ---\n name: glab-stack\n-description: Manage stacked diffs and merge requests with the GitLab CLI. Use when the user wants to create, save, amend, sync, navigate, or reorder a stack of dependent merge requests. Triggers on tasks involving stacked diffs, stacked MRs, dependent merge requests, or incremental code review workflows using `glab stack`.\n+description: Manage stacked diffs and merge requests with the GitLab CLI. Use when the user wants to create, save, amend, sync, navigate, reorder, or infer from commits a stack of dependent merge requests. Triggers on tasks involving stacked diffs, stacked MRs, dependent merge requests, or incremental code review workflows using `glab stack`.\n ---\n \n # glab stack\n@@ -39,11 +39,11 @@ Each diff should represent a discrete, logical concern that can be reviewed inde\n \n ## Agent rules\n \n-**These commands launch interactive TUIs or prompt for input — they will hang:**\n+**These commands launch interactive TUIs or prompt for input — they hang or fail without a TTY:**\n \n - ❌ `glab stack move` — fuzzy-finder for selecting a diff; agents cannot interact with it\n-- ❌ `glab stack reorder` without arguments — opens a text editor to reorder diffs; pass branch names in order instead (`glab stack reorder <branch>...`)\n-- ❌ `glab stack infer` without `--all` — opens a text editor to select commits; pass `--all` instead (`glab stack infer --all <revision-range>`)\n+- ❌ `glab stack reorder` without arguments — opens a text editor to reorder diffs, or fails without a TTY; pass branch names in order instead (`glab stack reorder <branch>...`)\n+- ❌ `glab stack infer` without `--all` — opens a text editor to select commits, or fails without a TTY; pass `--all` instead (`glab stack infer --all <revision-range>`)\n - ❌ `glab stack save` without `-m` — prompts interactively for a commit message if none is provided\n - ❌ `glab stack amend` without `-m` — prompts interactively for a description if none is provided\n - ❌ `glab stack create` without a name argument — may prompt\n@@ -54,8 +54,12 @@ Each diff should represent a discrete, logical concern that can be reviewed inde\n 2. **Use `glab stack list` to inspect the stack, not `glab stack move`.** `list` is non-interactive; `move` is not usable by agents.\n 3. **Navigate with `first`, `last`, `prev`, `next`.** These are all non-interactive. Do not use `move` for navigation.\n 4. **Pass an explicit name to `glab stack switch`.** Stack names are the directory names under `.git/stacked/`. Note: `switch` only changes the active stack in config — it does not check out any branch. After switching, use `glab stack last` (or `first`, `next`, etc.) to move to a diff in the new stack.\n-5. **To reorder diffs non-interactively**, run `glab stack reorder <branch>...` with the branches in the desired order. Run `glab stack list` first to get the branch names. If you omit the arguments, `reorder` fails fast when not on a TTY.\n-6. **To infer diffs from a commit range non-interactively**, run `glab stack infer --all <revision-range>`. If you omit `--all`, `infer` fails fast when not on a TTY.\n+5. **To reorder diffs non-interactively**, run `glab stack reorder <branch>...` with the branches in the desired order. Run `glab stack list` first to get the branch names.\n+   - List every branch in the stack exactly once. A missing, unknown, or duplicate branch is an error.\n+   - The first branch becomes the diff closest to the base branch; the last becomes the newest.\n+   - Commit or stash tracked changes first. `reorder` refuses to run with uncommitted changes.\n+   - `reorder` rebases branches locally only. Run `glab stack sync` afterwards to force-push them.\n+6. **To infer diffs from a commit range non-interactively**, run `glab stack infer --all <revision-range>`. If no stack is active, also pass `--name <stack-name>`, or `infer` fails without a TTY.\n \n ## Stack structure\n \n@@ -84,7 +88,10 @@ For precise control over which files go into a diff, stage with `git add <files>\n | Sync and set reviewer/assignee/label | `glab stack sync --reviewer <user> --assignee <user> --label <label>` |\n | Rebase stack onto latest base branch | `glab stack sync --update-base` |\n | Reorder diffs non-interactively | `glab stack reorder <branch>...` |\n+| Continue a reorder after resolving a conflict | `glab stack reorder --continue` |\n+| Abort a reorder and restore the original order | `glab stack reorder --abort` |\n | Add diffs from commit range without editor | `glab stack infer --all <revision-range>` |\n+| Infer into a new stack without editor | `glab stack infer --all --name <stack-name> <revision-range>` |\n | List all diffs in the stack | `glab stack list` |\n | Go to the oldest diff | `glab stack first` |\n | Go to the newest diff | `glab stack last` |\n@@ -150,3 +157,21 @@ git rebase --continue\n # Re-run sync to push the resolved stack\n glab stack sync\n ```\n+\n+### Handling reorder conflicts\n+\n+If `reorder` hits a conflict while rebasing a branch:\n+\n+```bash\n+# Resolve conflict markers in affected files, then:\n+git add <resolved-files>\n+git rebase --continue\n+\n+# Resume the reorder for the remaining branches\n+glab stack reorder --continue\n+\n+# Or restore the original branch order instead\n+glab stack reorder --abort\n+```\n+\n+After the reorder completes, run `glab stack sync` to push the rebased branches.\n",
  },
]

export const jobs4335 = [
  {
    name: "snapcraft_build_edge",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430441",
  },
  {
    name: "build_windows: [arm64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430440",
  },
  {
    name: "build_windows: [amd64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430439",
  },
  {
    name: "windows_installer: [arm64, arm64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430438",
  },
  {
    name: "windows_installer: [amd64, x86_64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430437",
  },
  {
    name: "build_test",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430436",
  },
  {
    name: "docs hugo_build",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430435",
  },
  {
    name: "check_docs_markdown",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430434",
  },
  {
    name: "check_docs_update",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430433",
  },
  {
    name: "check_args",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430432",
  },
  {
    name: "check_embed",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430431",
  },
  {
    name: "lint_commit",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430430",
  },
  {
    name: "dependency-scanning-profile-0",
    status: "success",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430429",
  },
  {
    name: "govulncheck",
    status: "manual",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430428",
  },
  {
    name: "secret_detection",
    status: "success",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430427",
  },
  {
    name: "gitlab-advanced-sast",
    status: "success",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17792430426",
  },
]

export const mergeRequest4344 = {
  iid: 4344,
  title: "ci: skip tests:coverage when a test job fails",
  description:
    "## What\n\n`tests:coverage` now uses its own rules (default `on_success`) instead of inheriting `.test`'s `when: always`.\n\n## Why\n\nIn pipeline https://gitlab.com/gitlab-org/cli/-/pipelines/3039029416, `tests:unit` failed with `runner_system_failure`, yet `tests:coverage` still ran and failed on the missing `coverage-unit.txt`. With `on_success`, coverage is skipped while a test job is failed and runs automatically once the retry passes.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  state: "opened",
  draft: false,
  has_conflicts: false,
  detailed_merge_status: "not_approved",
  sha: "428bf9b09b2ca16f92a9ac76781e12aa9fbebe61",
  web_url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/4344",
  source_branch: "jmc-coverage-skip-on-test-failure",
  target_branch: "main",
  merged_at: null,
  created_at: "2026-11-08T23:00:20.356Z",
  author: {
    username: "jay_mccure",
    bot: false,
  },
  head_pipeline: {
    id: 3042757154,
    status: "success",
    web_url: "https://gitlab.com/gitlab-org/cli/-/pipelines/3042757154",
  },
}

export const approvals4344 = {
  approved: false,
  approved_by: [
    {
      user: {
        username: "GitLabDuo",
      },
    },
  ],
}

export const diffs4344 = [
  {
    diff: "@@ -439,6 +439,10 @@ tests:coverage:\n   extends:\n     - .go-cache\n     - .test\n+  # Omit `when: always` so coverage only runs when tests succeed.\n+  rules:\n+    - *skip-on-release-schedule\n+    - changes: *code-patterns\n   needs:\n     - job: tests:unit\n       artifacts: true\n",
  },
]

export const jobs4344 = [
  {
    name: "snapcraft_build_edge",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869763",
  },
  {
    name: "build_windows: [arm64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869762",
  },
  {
    name: "build_windows: [amd64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869761",
  },
  {
    name: "windows_installer: [arm64, arm64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869760",
  },
  {
    name: "windows_installer: [amd64, x86_64]",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869759",
  },
  {
    name: "build_test",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869758",
  },
  {
    name: "tests:coverage",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869757",
  },
  {
    name: "tests:integration",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869756",
  },
  {
    name: "tests:unit",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869755",
  },
  {
    name: "lint",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869754",
  },
  {
    name: "lint:comments",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869753",
  },
  {
    name: "docs hugo_build",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869752",
  },
  {
    name: "check_docs_markdown",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869751",
  },
  {
    name: "check_docs_update",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869750",
  },
  {
    name: "check_args",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869749",
  },
  {
    name: "check_embed",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869748",
  },
  {
    name: "check_go_version",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869747",
  },
  {
    name: "lint_commit",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869746",
  },
  {
    name: "check_go_generated_code",
    status: "success",
    allow_failure: false,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869745",
  },
  {
    name: "dependency-scanning-profile-0",
    status: "success",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869744",
  },
  {
    name: "govulncheck",
    status: "manual",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869743",
  },
  {
    name: "secret_detection",
    status: "success",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869742",
  },
  {
    name: "gitlab-advanced-sast",
    status: "success",
    allow_failure: true,
    web_url: "https://gitlab.com/gitlab-org/cli/-/jobs/17846869741",
  },
]

export const notes4344 = [
  {
    id: 2001,
    body: "added 1 commit",
    author: { username: "jay_mccure", bot: false },
    created_at: "2026-11-08T10:00:00.000Z",
    system: true,
    position: null,
  },
  {
    id: 2002,
    body: "Should this also skip on release schedules?",
    author: { username: "reviewer", bot: false },
    created_at: "2026-11-08T11:00:00.000Z",
    system: false,
    position: {
      new_path: ".gitlab-ci.yml",
      new_line: 443,
      old_path: ".gitlab-ci.yml",
      old_line: null,
    },
  },
  {
    id: 2003,
    body: "The old rule is gone now.",
    author: { username: "reviewer", bot: false },
    created_at: "2026-11-08T11:05:00.000Z",
    system: false,
    position: {
      new_path: ".gitlab-ci.yml",
      new_line: null,
      old_path: ".gitlab-ci.yml",
      old_line: 440,
    },
  },
  {
    id: 2004,
    body: "Yes, it inherits the release rule.",
    author: { username: "jay_mccure", bot: false },
    created_at: "2026-11-08T12:00:00.000Z",
    system: false,
  },
  {
    id: 2005,
    body: "Code review summary",
    author: { username: "GitLabDuo", bot: true },
    created_at: "2026-11-08T12:30:00.000Z",
    system: false,
    position: null,
  },
]
