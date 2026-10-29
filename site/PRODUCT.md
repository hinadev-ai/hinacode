# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who already run Claude Code or Codex from the terminal and now run several agents at once, across repositories and worktrees. They visit the site to decide whether HinaCode is worth installing next to the CLIs they already trust.

## Product Purpose

HinaCode is a free desktop app (macOS on Apple Silicon, Linux AppImage) that runs coding agents side by side, each thread in its own git worktree. It stays quiet while agents work and shows exactly which one needs a human: an approval, a question, a failed setup. The site succeeds when a developer understands that in seconds and downloads it.

## Positioning

A harness, not a chat app. It manages the agent loop (start, steer, review, ship) around the CLIs the developer already signed in to, instead of replacing them with its own model or account.

## Operating Context

Agents run locally against the developer's own repositories. HinaCode uses the `claude` and `codex` CLIs already on the machine, so there are no new API keys. Secrets live in the OS keychain.

## Capabilities and Constraints

- Agents: Claude Code (Agent SDK), Codex (app-server protocol), Muse Code.
- A worktree per thread, inline approvals, steering a running turn, a built-in MCP server (`review_changes`, `link_pull_request`, Linear tools), pull requests with merge and CI state, a ports panel, automations from webhooks, GitHub, Linear and Slack, rebindable keyboard shortcuts.
- Free: every feature, no seats, tiers or trial.
- Experimental: still in development, with rough edges and breaking changes.
- The site is static Astro on Cloudflare Workers, in English, Traditional Chinese and Japanese. Copy lives in `messages/*.json` under `site_` keys.

## Brand Commitments

- Name: HinaCode. Its own identity, separate from hinadev (日名開発), though made by the same person.
- Voice: plain, specific, calm. No exclamation marks, no hype.
- The site's mark, favicon and main color are being replaced. The purple two-ring mark is retired on the site. The desktop app keeps its current icon and violet accent for now.

## Evidence on Hand

- The product itself, which the site can demonstrate with an interactive mock of the app.
- Made by Kalan, one person. There are no customers, testimonials, user counts or benchmarks; do not invent them.

## Product Principles

1. Signal over chrome: color and motion go to what needs a human.
2. Show the work: worktrees, diffs, commands and PR state are the proof.
3. Ambitious ideas, simple systems.
4. Honest about stage: free and experimental, stated plainly.
