# Consistent access modes

Status: Shipped
Date: 2026-11-11

## Problem

A developer who picks Full access expects the agent to run without asking. Each agent maps the mode to its own policy, and each could still ask. Codex keeps the old policy until the next turn. A Muse session woken while idle keeps its old profile. A `run_agent` sub-run keeps the mode it started with. When Claude Code's settings disable bypass, it runs in another mode while the thread still shows Full access. A thread started by `create_thread` took the default mode instead of the caller's. The labels also overstated what Auto does on agents and models without an auto mode.

## User flow

1. The developer opens the model picker (`Alt+M` steps through the modes).
2. The three access toggles name what the mode does on this agent and model. On Claude without auto mode, and on magpie and opencode, the middle toggle reads Accept edits. On Muse the toggles read Ask me, Auto-review and Unrestricted. The phone shows the same labels and hints.
3. With Full access, no approval card appears, including in wake turns and sub-agents.
4. When Claude Code's settings set `disableBypassPermissionsMode`, a Full access turn fails with that reason and asks the developer to pick Auto or Supervised.
5. A thread an agent starts with `create_thread` runs in the calling thread's mode, on this machine or another.

## Design

- `src/shared/access.ts` maps an agent, a mode and a model to an `AccessBehavior`. `ComposerControls.tsx` and the phone's `access-mode.tsx` keep one label and hint per behavior, so they cannot drift per agent.
- `AgentRunner`'s turn `handle` answers allow for any `approval_requested` on a thread whose stored mode is `full`, through the provider named in the request. Turns, wake turns and sub-runs all pass through it.
- The Claude provider reads the mode in the first `init` message of each CLI process, which is the mode the CLI started in. When it launched the CLI in `bypassPermissions` and the CLI reports another mode that HinaCode has not switched to since, the turn fails. A refused switch later in the session already fails through `setPermissionMode`.
- `create_thread` passes the caller's `accessMode` to `Threads.create` and to `threads.create` on another machine. Side chats stay `supervised` (see `2026-10-30-side-chat.md`).

## Out of scope

- Hiding modes. Every agent supports all three, so the picker always offers them and names what each does instead.
- Applying a Codex mode change to the running turn. The runner covers its approvals, and the sandbox changes on the next turn.
- Approvals Claude asks while no turn runs. `approvals.ts` denies them as before.

## Verification

- `src/shared/access.test.ts` covers the table.
- `AgentRunner.integration.test.ts` covers a full thread's approval in a turn and in a wake turn. `mcp/server.integration.test.ts` covers a `run_agent` sub-run and `create_thread` inheritance, and `crossMachine.integration.test.ts` covers inheritance on another machine.
- Each agent's integration test checks that a full turn reaches its fake agent with the no-approval policy: `--permission-mode=bypassPermissions` for Claude and magpie, `approvalPolicy: "never"` for Codex, and a local allow for opencode.
- `ComposerControls.component.test.tsx` checks the labels for Claude without auto mode and for Muse.
