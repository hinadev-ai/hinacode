# 0012. Vitest with @effect/vitest, plus Playwright BDD against the real app

Status: Proposed (branch `feat/testing`)
Date: 2026-10-12

## Context

Tests run on `node:test` with hand-written Effect plumbing, and there's no e2e suite. `verify-kkcode` proves features by hand.

## Decision

- **Unit and integration:** Vitest with `@effect/vitest`, split into a `unit` project and an `integration` project. Integration tests are named `*.integration.test.ts`, and they use real SQLite, git, processes or HTTP. Tests are written with `it.effect` and use `expect` assertions.
- **RPC contract test:** an integration test calls `ipc.ts` with the real service layer and a mocked `electron`.
- **e2e:** `@playwright/test` with `playwright-bdd`. Each worker launches the built Electron app on `DISPLAY=:99` with its own `KKCODE_USER_DATA`. Agent turns are excluded to keep runs cheap.

## Consequences

Effect code is tested in its own idiom, and e2e covers flows the unit tests can't reach. The cost is one more toolchain (Playwright and browsers) to keep current.
