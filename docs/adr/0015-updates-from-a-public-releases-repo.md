# 0015. Updates from a public releases repository

Status: Accepted
Date: 2026-10-13

## Context

Every installed kkcode has its update feed baked in at build time, so moving the feed later needs one last release that points every install somewhere new. The source repository `kjj6198/kkcode` is private, and GitHub release assets in a private repository need a token to download. Shipping a token inside the app would leak it, and borrowing the user's `gh` login only works for people with access to the source.

macOS only installs an update in place when the app carries a Developer ID signature, because Squirrel.Mac checks the new bundle against the running app's designated requirement. An ad-hoc signature ties that requirement to one exact build, so the next build never matches it.

## Decision

Release builds are signed with a Developer ID certificate, notarized, and published by `electron-builder` to the public `kjj6198/kkcode-releases` repository. `electron-updater` reads that repository's latest GitHub release without a token.

## Consequences

- The source stays private while anyone can download and update the app. The site's download links point at the releases repository.
- Releasing needs a Developer ID certificate, an App Store Connect API key for notarization, and a `GH_TOKEN` that can write to `kkcode-releases`.
- Builds signed ad hoc or with another identity cannot update to a release. v0.0.1 users reinstall once.
- Revisit this if the source goes public, since the releases could then live next to it.
