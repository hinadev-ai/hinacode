# HinaCode

HinaCode is a desktop UI for coding agents. It runs Claude Code (Agent SDK), Codex (app-server protocol) and Muse Code (MSP) side by side, so a developer can run many agents in parallel and still know what each one is doing, where it is working, and what it shipped.

We are building a harness, not a chat app. Our features help a developer manage the agent loop: a worktree per thread, inline approvals, steering a running turn, a built-in MCP server (`review_changes`, `link_pull_request`, Linear tools), PR links with merge state, a ports panel, and automations triggered by webhooks or by GitHub, Linear and Slack pollers. Read `README.md` for the full feature list.

## How we build

- **Ambitious ideas, simple systems.** Propose the bold version of a feature, then build it with as few moving parts as possible. A single SQLite file, a single `rpc` channel, and one `AgentProvider` interface are deliberate choices. Don't add a queue, a cache, a daemon or a framework until something actually breaks without it.
- **Delete before you add.** If a feature can be built by removing a special case, do that.
- **Dogfood.** HinaCode is built with HinaCode. If the agent workflow is painful while you work here, that pain is a product bug.
- **End to end in small slices.** Ship one vertical path that works in the real app before you generalize it.

## Commands

```sh
pnpm dev          # electron-vite dev
pnpm build        # main, preload and renderer into out/
pnpm typecheck    # node, web and web-test tsconfigs
pnpm lint         # oxlint
pnpm format       # oxfmt (no semicolons, width 120)
pnpm test         # node --test, *.test.ts next to source
pnpm check:specs  # TLC over specs/*.cfg, needs Java 11+ (see specs/README.md)
```

Run `pnpm typecheck && pnpm lint && pnpm test` before you call work done. CI runs the same checks on every pull request, plus `pnpm test:e2e` on `ubuntu-latest`, and on the self-hosted home Mac for branches in this repo (never for forks), and React Doctor comments on the ones that touch React code.

## Architecture

```
src/main      Electron main. One Effect ManagedRuntime built in index.ts.
  agents/     AgentProvider implementations: claude/, codex/. Registered in services/AgentRunner.ts.
  services/   Effect services (Threads, Worktrees, Projects, Git, PullRequests, Secrets, automations/, ...)
  mcp/        HTTP MCP server on 127.0.0.1, one bearer credential per thread
  db/         SQLite client, migrations/NNNN_name, testing.ts seed helpers
  ipc.ts      rpc handlers; security.ts for navigation, external links and sender checks
src/preload   contextBridge exposing window.hinacode { rpc, onEvent, pathForFile }
src/renderer  React 19, TanStack Router, zustand stores, Tailwind 4, shadcn on Base UI
src/shared    Effect Schema contracts only: contract.ts (rpc method map), domain.ts, agent.ts
messages/     Paraglide catalogs: en.json, zh-TW.json and ja.json
```

- Renderer and main talk over one `rpc` IPC channel. Add a method to `src/shared/contract.ts` with request and response schemas, then handle it in `src/main/ipc.ts`. Main pushes live updates on the `event` channel.
- Main-process code is Effect services: `class X extends Context.Service<...>` plus an exported `layer`. Follow `services/Threads.ts`.
- Each schema change gets a new migration in `src/main/db/migrations/`. Never edit a migration that has shipped.
- A new agent backend is one `AgentProvider` in `src/main/agents/` plus the registrations listed under "Agent providers" in `docs/arch.md`.
- Every UI string lives in `messages/en.json`, `messages/zh-TW.json` and `messages/ja.json`. Add all three; `src/renderer/messages.test.ts` fails when a catalog misses a key or a placeholder. Don't hardcode copy in components.

## Conventions

- The renderer lints with the React Compiler rules (`react/purity`, `react/refs` and the rest) and the React Doctor rules listed in `.oxlintrc.json`. Code the compiler cannot optimize fails `pnpm lint`.
- Tests use `node:test` and `node:assert/strict`, run against a real SQLite DB (`db/testing.ts`) and real temp git repos. Don't mock what you can run.
- For a bug, commit a failing `test(scope): reproduce ...` first, then the fix.
- Icons come from `react-icons/ri` (Remix). shadcn has no react-icons option, so `components.json` says `remixicon` and `shadcn add` writes `@remixicon/react` imports. Change them to `react-icons/ri`; the icon names are the same.
- An icon Remix lacks is drawn as a component in `src/renderer/components/icons/`, on Remix's 24-unit grid in `currentColor`, like `SkillIcon`.
- Add shadcn components into `src/renderer/components/ui/` with the `base-nova` style. They are built on `@base-ui/react`, not Radix.
- The product's display name is HinaCode, in UI copy, agent-facing prose and docs. Names, IDs, labels and schemes stay `hinacode`: the MCP server, `hinacode://`, `hinacode serve`. Only `app.setName` and the profile directory keep the old `kkcode`, so installs keep their data and Keychain item (see `src/main/index.ts`)
- Branches are `feat/*` or `fix/*`, merged into `main` by PR. Commits follow Conventional Commits with a scope, e.g. `fix(mcp): bind credentials to one thread`.

## Verifying in the real app

Use the `verify-hinacode` skill (`.agents/skills/verify-hinacode/`) to launch an isolated instance over Xvfb and CDP, drive it, and take screenshots. Each instance gets its own `HINACODE_USER_DATA` and CDP port. Never drive an instance you didn't launch. Put screenshots and scratch files in `.context/`, which is gitignored.

To stress-test the UI with worst-case data (long names, RTL text, missing files, huge lists), start the instance with `scripts/break-ui/launch.sh` instead. See `scripts/break-ui/README.md`.

Add skills under `.agents/skills/`. `.claude/skills` is a symlink to it.

## Security

HinaCode runs agents that execute code on the user's machine. Hold a few boundaries firmly and keep everything else simple.

- **Boundaries we hold:**
  - The renderer is sandboxed and only the top-level app frame may call `rpc`.
  - `shell.openExternal` only opens http(s) URLs.
  - The MCP server listens on loopback only, and its credential scopes each call to one thread.
  - Webhooks require an HMAC signature, checked with `timingSafeEqual`.
  - The attachment protocol refuses paths outside its root.
- **Secrets** go through `services/Secrets.ts` (Electron `safeStorage`). Never log them, put them in a URL, or send them to the renderer. Only the packaged desktop app uses the real login Keychain. Unpackaged runs and `hinacode serve` switch themselves to Chromium's mock keychain (`src/main/index.ts`), so never add a launch path that asks the user for their password.
- **Anything that crosses a process or network boundary** gets decoded with a schema, and the change gets a test like `security.test.ts` or `mcp/server.test.ts`.
- **Importing a project trusts it.** Its `.claude` settings, hooks and `CLAUDE.md` load the same way they do in the CLI. There is no per-project trust setting, so don't add one (see `docs/adr/0008-import-trusts-the-project.md`).
- **Don't over-engineer.** This is a single-user local app. Skip RBAC, audit logs, rate limiters, and encryption layers on top of the OS keyring. If a threat needs an attacker who already has the user's shell, it is out of scope.

## Docs

`docs/` holds the thinking that the code can't show. See `docs/README.md` for templates.

- `docs/features/YYYY-MM-DD-feature-name.md`: write the design before you build any non-trivial feature. Cover the problem, the user flow, the design, what's out of scope, and how to verify it.
- `docs/adr/NNNN-title.md`: one decision per file, for choices that are expensive to reverse.
- `docs/arch.md`: how the codebase fits together, in mermaid diagrams. Update it when you change a boundary, a lifecycle or the data model.
- `docs/operations/`: runbooks for releasing, debugging and recovering user data.

Keep docs short. Update a doc when its feature changes, and delete it when the feature is gone.
