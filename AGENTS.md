# kkcode

kkcode is a desktop UI for coding agents. It runs Claude Code (Agent SDK), Codex (app-server protocol) and Muse Code (MSP) side by side, so a developer can run many agents in parallel and still know what each one is doing, where it is working, and what it shipped.

We are building a harness, not a chat app. Our features help a developer manage the agent loop: a worktree per thread, inline approvals, steering a running turn, a built-in MCP server (`review_changes`, `link_pull_request`, Linear tools), PR links with merge state, a ports panel, and automations triggered by webhooks or by GitHub, Linear and Slack pollers. Read `README.md` for the full feature list.

## How we build

- **Ambitious ideas, simple systems.** Propose the bold version of a feature, then build it with as few moving parts as possible. A single SQLite file, a single `rpc` channel, and one `AgentProvider` interface are deliberate choices. Don't add a queue, a cache, a daemon or a framework until something actually breaks without it.
- **Delete before you add.** If a feature can be built by removing a special case, do that.
- **Dogfood.** kkcode is built with kkcode. If the agent workflow is painful while you work here, that pain is a product bug.
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

Run `pnpm typecheck && pnpm lint && pnpm test` before you call work done. CI runs the same checks on every pull request, plus `pnpm test:e2e` on the self-hosted home runner, and React Doctor comments on the ones that touch React code.

## Architecture

```
src/main      Electron main. One Effect ManagedRuntime built in index.ts.
  agents/     AgentProvider implementations: claude/, codex/. Registered in services/AgentRunner.ts.
  services/   Effect services (Threads, Worktrees, Projects, Git, PullRequests, Secrets, automations/, ...)
  mcp/        HTTP MCP server on 127.0.0.1, one bearer credential per thread
  db/         SQLite client, migrations/NNNN_name, testing.ts seed helpers
  ipc.ts      rpc handlers; security.ts for navigation, external links and sender checks
src/preload   contextBridge exposing window.kkcode { rpc, onEvent, pathForFile }
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
- Add shadcn components into `src/renderer/components/ui/` with the `base-nova` style. They are built on `@base-ui/react`, not Radix.
- Branches are `feat/*` or `fix/*`, merged into `main` by PR. Commits follow Conventional Commits with a scope, e.g. `fix(mcp): bind credentials to one thread`.

## Verifying in the real app

Use the `verify-kkcode` skill (`.agents/skills/verify-kkcode/`) to launch an isolated instance over Xvfb and CDP, drive it, and take screenshots. Each instance gets its own `KKCODE_USER_DATA` and CDP port. Never drive an instance you didn't launch. Put screenshots and scratch files in `.context/`, which is gitignored.

Add skills under `.agents/skills/`. `.claude/skills` is a symlink to it.

## Security

kkcode runs agents that execute code on the user's machine. Hold a few boundaries firmly and keep everything else simple.

- **Boundaries we hold:**
  - The renderer is sandboxed and only the top-level app frame may call `rpc`.
  - `shell.openExternal` only opens http(s) URLs.
  - The MCP server listens on loopback only, and its credential scopes each call to one thread.
  - Webhooks require an HMAC signature, checked with `timingSafeEqual`.
  - The attachment protocol refuses paths outside its root.
- **Secrets** go through `services/Secrets.ts` (Electron `safeStorage`). Never log them, put them in a URL, or send them to the renderer.
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

## Design Context

### Users

Developers who run several Claude Code and Codex agents at once across repositories and worktrees. They glance at kkcode between other work. The job is to see which agent needs them (an approval, a question, a failed setup), steer it, review what it changed, and ship the PR. Their attention is the scarce resource, and the UI should spend it only when an agent actually needs a human.

### Brand Personality

**Calm, precise, trustworthy.** A quiet control room. The interface recedes so agent output is the content. The developer should feel confident and in control, never anxious or rushed. Copy is plain and specific, with no exclamation marks and no cheerleading.

### Aesthetic Direction

- **Reference:** Linear. Restrained neutrals, crisp type, tight but breathable density, fast and keyboard-driven, motion that confirms rather than performs.
- **Anti-references:** chat-app bubbles, gradient AI glow, sparkle icons, dashboard confetti, cards inside cards, and color used as decoration.
- **Color:** a grayscale OKLCH base (shadcn neutral in `src/renderer/index.css`) with the brand violet `#7c3aed` from `assets/icon.svg`. Use violet sparingly for focus, the primary action, and "agent is working". Status colors are semantic and stay consistent: amber means it needs you, emerald means it is running, red means failed or destructive. Pull these into tokens instead of scattering raw Tailwind palette classes.
- **Type:** Geist Variable for UI. Code and paths use a monospace stack. Rely on weight and size for hierarchy before color.
- **Theme:** light and dark are equal citizens, and every UI change is checked in both. Today the app is dark only: `index.html` hardcodes `class="dark"`, and the diff viewer and mermaid are themed dark. Theme parity is open work. Don't add new dark-only assumptions.
- **Motion:** use the easings in `index.css` (`--ease-out` and the rest), keep it short (under 200 ms for UI feedback), and use the `pressable` utility for press feedback. Every animation has a reduced-motion variant.

### Design Principles

1. **Signal over chrome.** Color, motion and badges are reserved for states that need a human. A screen where nothing needs attention should look quiet.
2. **Glanceable state.** Whether a thread is running, waiting, failed or done should be readable from the sidebar alone, without opening the thread.
3. **Keyboard first, pointer friendly.** Every frequent action has a rebindable shortcut, shown as `Kbd`. Hit areas stay generous.
4. **Show the work.** Diffs, worktree paths, commands and PR state are first class and inspectable. Never hide what an agent did behind a summary.
5. **Accessible by default.** Meet WCAG 2.2 AA contrast in both themes and keep focus rings at 3:1. Use roles and accessible names, which also make the UI drivable by `verify-kkcode`. Respect `prefers-reduced-motion`. Never use color as the only signal.
