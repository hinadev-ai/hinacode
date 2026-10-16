# 0008. Importing a project trusts it

Status: Accepted
Date: 2026-10-12

## Context

A repository's `.claude/settings.json` can define hooks and allow rules, and those run before hinacode's approval card. The audit (#8) proposed a per-project trust flag, off by default. PR #28 shipped it, and it gated `.claude` settings and `CLAUDE.md` behind a checkbox.

In practice, users import their own repositories so agents can work in them. With the flag off, the project's `CLAUDE.md`, skills and hooks silently stopped loading. That broke the "loads like the CLI" promise and added a setting that nobody wanted to leave off.

## Decision

There is no trust setting. Importing a project is the trust decision, the same as running `claude` or `codex` in that folder. Claude sessions load `user`, `project` and `local` settings for every project. PR #28's code and its migration were removed.

## Consequences

- A project behaves the same in hinacode as in the CLI. That includes its `CLAUDE.md`, `AGENTS.md`, skills and hooks.
- Importing a repository you haven't reviewed runs its hooks on the first prompt, just as the CLI does. Don't add a trust gate back unless hinacode starts importing repositories the user didn't choose, for example an automation that clones one.
- Databases that ran the removed migration keep an unused `project.trusted` column, and its migration id (3) stays recorded. The next migration is numbered 4.
