# 0018. Releases next to the source

Status: Accepted
Date: 2026-10-17

## Context

[ADR 0015](0015-updates-from-a-public-releases-repo.md) published releases to a separate public repository because the source was private, and `electron-updater` cannot download assets from a private repository without a token. That cost a personal access token in CI, a second repository to keep in sync, and release pages that lived away from the code and its issues.

The source repository is now public.

## Decision

`electron-builder` publishes each `v*` tag as a GitHub release of this repository, and `electron-updater` reads the latest release here. The `Build` workflow uses its own `GITHUB_TOKEN` with `contents: write`; there is no separate releases repository or token.

## Consequences

- One repository holds the code, the issues and the downloads. The site links to this repository's releases.
- The feed URL is baked into each build, so a release made before this change keeps looking at the old repository. Installs older than this ADR reinstall once from the new releases page.
- Making the repository private again would break updates for every install, since the feed needs public assets.
