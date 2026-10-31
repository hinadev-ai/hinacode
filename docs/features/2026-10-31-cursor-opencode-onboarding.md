# Cursor, opencode and choosing your agents

Status: Building
Date: 2026-10-31

## Problem

HinaCode runs Claude Code, Codex and Muse Code. A developer who pays for Cursor or runs open models through opencode cannot use them here, so they keep a second tool open and lose the worktree, approvals and PR links for that work. Every agent also shows up everywhere, in the model picker, the settings and the automation form, even the ones the developer never installed. A first launch drops them into the app with no hint of which agents it found or how to sign in to the rest.

## User flow

1. On first launch, before any project, HinaCode shows "Choose your agents" with one row per agent: Claude Code, Codex, Muse Code, Cursor and opencode. Each row says whether the CLI is installed, and links to its install page when it is not. Check again looks for the CLIs again after the developer installs one.
2. Installed agents start switched on. The developer flips switches with the mouse, or with Tab and Space, and presses Start. Start is disabled while every switch is off.
3. The app opens as before. The model picker, new threads, the automation form, the machine setup checklist, the agent update notices and Settings → Providers cover only the enabled agents.
4. Settings → Providers starts with the same rows, so the developer can turn an agent on later. Turning one off hides it from pickers. Threads that already run on it keep running on it. The last agent that is on cannot be turned off.
5. A Cursor or opencode thread works like any other: streaming text and reasoning, tool rows, file changes, inline approvals, the plan, Stop and the context meter.

## Design

- `ProviderId` gains `cursor` and `opencode`. Both speak the [Agent Client Protocol](https://agentclientprotocol.com) over stdio (`cursor-agent acp`, `opencode acp`), so one ACP provider in `src/main/agents/acp/` serves both, configured by binary, arguments and environment. `src/main/agents/cursor/` and `src/main/agents/opencode/` only hold that configuration and the account check.
- One ACP process per agent, restarted when it dies. Each thread gets its own ACP session, created with the thread `cwd` and the HinaCode MCP server. A resumed thread calls `session/load` and drops the history it replays.
- HinaCode owns the access mode. opencode starts with `permission: "ask"` through `OPENCODE_CONFIG_CONTENT`, so it asks before every tool. The provider answers `session/request_permission` itself for `full`, and for edits and reads in `auto`, and shows the approval card for the rest.
- `session/update` maps to `AgentEvent` in a pure function: message and thought chunks to deltas, `tool_call` and `tool_call_update` to paired tool events and `file_changed` for diffs, `plan` to a synthetic `update_plan` call like Codex, and `usage_update` to the context window on `turn_completed`.
- Models come from a probe session's `configOptions` (category `model`), or the older `models` field. The turn picks its model with `session/set_config_option`, or `session/set_model`.
- Cursor calls `authenticate` only after `session/new` reports that sign-in is required. Calling it right after `initialize` hangs a signed-out `cursor-agent`.
- `steersRunningTurn` in `src/shared/providers.ts` hides the steer button, the Mod+Enter chord and "Steer now" in the queue for Cursor and opencode. Settings hides auto-compact for them.
- `Settings.enabledProviders` is `null` until the developer finishes onboarding, then the list they chose. `App` in `src/renderer/main.tsx` shows `Onboarding` instead of the router while it is `null`, so existing installs see the screen once, with their installed agents on. `enabledProviders()` and `newThreadProvider()` in `src/shared/providers.ts` are the one place that reads it. Start also moves `defaultProvider` to an enabled agent.
- The rpc `agents.detect` returns, per provider, whether its CLI is on `PATH`. It reuses `findBinary`.
- Every per-agent settings struct is built by one `perProvider` helper whose keys default on decode, so adding an agent no longer breaks settings saved by an older version.
- Migration `0032_acp_providers` widens the `provider` CHECK on `thread` and `automation`.

## Out of scope

- Steering a running turn. ACP has no steer, so the provider leaves `steer` out and the runner queues anything that would steer, including `send_to_thread` and pull request notices.
- Sub-agents, background tasks, forks, account switching and compaction. ACP has no wire form for them yet.
- Signing in from HinaCode. Both CLIs sign in through their own browser flow, and the onboarding row links to it.

## Verification

- `acp/updates.test.ts`, `acp/approvals.test.ts` and `acp/models.test.ts` cover the pure mapping. `acp/index.integration.test.ts` runs `acp/fakeAgent.ts` over stdio through a turn with a tool call, approvals in each access mode, interrupt, resume, both model shapes, sign-in and steer.
- `domain.test.ts` decodes settings saved before this change.
- `e2e/features/choose-agents.feature` walks the first-run screen and the Settings switches. `spawnApp` seeds every agent on, so other scenarios skip the screen.
- With `verify-hinacode`: start with an empty profile, screenshot the welcome screen, pick opencode only, send a prompt that writes a file, and screenshot the tool row and the approval card.
