<img src="assets/icon.svg" width="64" height="64" alt="">

# KKCode

KKCode is an Electron app built for coding agents. It currently supports Claude Code, Codex and Muse Code.

## Development

Requires Node 24 or later, pnpm, and the `claude` and `codex` CLIs on your PATH and logged in. Muse Code threads need the `muse` CLI, signed in with `muse login`. Global file search and its integration tests require ripgrep (`rg`) on your PATH.

```sh
pnpm install
pnpm dev
```

```sh
pnpm build        # bundles main, preload and renderer into out/
pnpm typecheck
pnpm lint
pnpm format
pnpm test         # node --test for the pure logic (pollers, templates, signatures)
```

Run a built app with its own data directory, for example to keep a test profile apart from your real one:

```sh
KKCODE_USER_DATA=/tmp/kkcode-test pnpm exec electron out/main/index.js
```

Unpackaged runs (`pnpm dev`, `pnpm serve`, e2e and the command above) never touch the login Keychain. They seal secrets with Chromium's public mock key, so save only dummy secrets in them. Without `KKCODE_USER_DATA` they use the `kkcode-dev` profile, not the release app's.

Simulate an exhausted Claude account without using the account:

```sh
KKCODE_USER_DATA=/tmp/kk-limit-demo KKCODE_MOCK_CLAUDE=usage-limit pnpm dev
```

The first message in each thread reaches the limit. The next attempt succeeds. The callout offers **Resume at reset**, which retries once at the provider's reset time and survives restart. Set `KKCODE_MOCK_RESET_MS=5000` for a five-second reset. Use `KKCODE_MOCK_CLAUDE=org-spend-limit` to simulate the organization monthly spend cap and its `/usage-credits` guidance. That case has no automatic reset action.

Headless verification on a machine without a display uses Xvfb and Chrome DevTools:

```sh
Xvfb :99 -screen 0 1600x1000x24 &
KKCODE_USER_DATA=/tmp/kkcode-test DISPLAY=:99 pnpm exec electron --no-sandbox --disable-gpu --remote-debugging-port=9222 out/main/index.js
```

## Layout

The marketing site in [`site/`](site/README.md) uses Astro and Tailwind, with English, Traditional Chinese, and Japanese pages. Run it with `pnpm --dir site dev` and deploy it to Cloudflare Workers with `pnpm --dir site deploy`.

```
src/main      Electron main process. One Effect runtime, services under services/, agents under agents/,
              the MCP server under mcp/, SQLite client and migrations under db/.
src/preload   contextBridge exposing window.kkcode (rpc, onEvent, pathForFile).
src/renderer  React 19 + TanStack Router. components/, routes/, stores/ (zustand), keybindings/, paraglide/ (generated).
src/shared    Effect Schema contracts shared by all three: domain types, the rpc method map, agent events.
messages/     Paraglide catalogs: en.json, zh-TW.json and ja.json. Every UI string lives here.
```

Renderer and main talk over a single `rpc` IPC channel. Each method in `src/shared/contract.ts` has a request and response schema that both sides decode. Main pushes live updates on the `event` channel.

Adding an agent backend means one implementation of `AgentProvider` in `src/main/agents/` and one line in the runner's provider registry.

## Testing

| Command                 | What runs                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test:unit`        | Vitest, in-process: pure helpers, stores, event mapping. Files named `*.test.ts`.                                                                              |
| `pnpm test:integration` | Vitest against real SQLite files, git, child processes and the MCP HTTP server. Files named `*.integration.test.ts`.                                           |
| `pnpm test`             | Both Vitest projects.                                                                                                                                          |
| `pnpm test:e2e`         | Playwright drives the built Electron app through Gherkin scenarios in `e2e/features`. Needs a display: `DISPLAY` or an `Xvfb :99`, or run under `xvfb-run -a`. |

Effect code is tested with `@effect/vitest`: `it.effect` runs under the test clock, `it.live` on the real one, and `layer(...)` shares a built layer across a block. Every e2e worker starts its own KKCode on a throwaway `KKCODE_USER_DATA`, seeds preconditions through `window.kkcode.rpc` or straight into SQLite, and drives the behavior under test through the UI.

Scenarios that depend on native pointer capture, scrolling or window focus carry `@desktop`. They run with one worker after the parallel scenarios finish, because separate app profiles still share the desktop's focus and input.

Run selected desktop scenarios with `pnpm test:e2e --project desktop --no-deps -g 'Resizable'`. The `--no-deps` flag skips the parallel project for a focused run.

Tests never wait on wall-clock timers; oxlint rejects `setTimeout`, `setInterval` and the `timers` modules in test files. Wait on the thing itself instead: a push event, a `PubSub` the service publishes to, a file change, a Playwright locator assertion, or `TestClock.adjust` for code that sleeps. The verification skill in `.agents/skills/verify-kkcode` picks up where e2e stops: real agent turns, GitHub through `gh`, and native dialogs.

## Acknowledgements

Several designs in KKCode follow [T3 Code](https://github.com/pingdotgg/t3code) (MIT, copyright 2026 T3 Tools Inc.), reimplemented here rather than copied:

- Effect services as `Context.Service` classes with a `make` effect and a `layer` export, and migrations registered through `Migrator.fromRecord`.
- The MCP server design: Effect's `McpServer.layerHttp` behind bearer auth, one random credential per thread, injected into the agent's MCP config. The pull request tools (`link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`) and `request_secret` share T3 Code's names.
- The pull request checks rollup: `null` when a PR has no checks, failing before pending before passing, and `workflow / name` as the check label.
- Webhook automations verified with a `sha256=` HMAC in `x-hub-signature-256`, with `{{path}}` placeholders filled into the prompt.
