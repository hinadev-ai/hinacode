# 0003. node:sqlite through @effect/sql, no ORM

Status: Accepted
Date: 2026-10-11

## Context

better-sqlite3 needs a native rebuild against each Electron version. Drizzle's `node:sqlite` driver was a 1.0 release candidate.

## Decision

Use Node's built-in `node:sqlite` through `@effect/sql-sqlite-node`, with WAL and foreign keys on. Columns are snake_case in SQL and camelCase in TypeScript. Migrations are numbered files in `src/main/db/migrations/`. Queries are hand-written SQL through `SqlSchema`.

## Consequences

- No native modules to rebuild, and the queries are what you read.
- Widening a `CHECK` enum (for example, adding a `removing` worktree status) needs a table rebuild, so we avoid it unless we must.
