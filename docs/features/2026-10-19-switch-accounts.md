# Switch a thread's account

Status: Building
Date: 2026-10-19

## Problem

A developer with two Claude or Codex accounts hits the 5-hour limit on one of them halfway through a thread. The thread is locked to the account it started on, because the agent's transcript lives in that account's home. Their options are to wait for the reset, or to start a new thread on the other account and explain everything again.

## User flow

1. The composer's account picker stays enabled after the first message. It is disabled only while a turn runs.
2. Each account in the picker shows how much of its plan is used, or "Limit reached, resets in 2h 10m" when a window it needs is spent. A spent account can still be picked.
3. When the thread's account has a spent window, a notice above the composer says so before the developer sends anything. It offers "Switch to Work", the least-used account of the same agent that has room left.
4. When a turn is refused for a usage limit, the limit callout offers "Continue on Work" next to "Resume at reset". It moves the thread and tells the agent to continue the task on the new account.
5. With "Switch accounts at a usage limit" on in Settings > Models, a limited thread does step 4 by itself, onto the account with the most room left for its model. The setting is per agent and shows once the agent has an added account.
6. Steps 4 and 5 leave a rule in the transcript, such as "Work reached its usage limit. Switched to Personal automatically."
7. After a switch the next turn resumes the same conversation on the new account, with its full history.

## Design

- The handoff copies the session's transcript into the new account's home, then resumes it by the same session id. Claude Code keeps a session in `<home>/projects/<cwd folder>/<id>.jsonl` plus agent transcripts in `<id>/`. Codex keeps a thread in `<home>/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` plus one rollout per sub-agent. Both find a session by scanning those folders, so a copied file is enough. Copying, not moving, leaves the old account's history intact, and copying again overwrites, so switching back and forth converges.
- `AgentProvider.copySession(sessionId, from, to)` is optional. Muse Code has no added accounts and leaves it out.
- rpc `threads.switchAccount { id, accountId, continueTurn? }` runs in `AgentRunner` under the thread's lock. It is refused while a turn runs. A thread with a session is copied first, then gets the new `accountId`. A `limited` thread goes back to `idle`, since its limit belonged to the old account.
- `continueTurn` starts a turn on the new account. A limited Claude turn stays in the session up to where it stopped, with a synthetic error after it, so resending the prompt would repeat the task. The agent gets a short note to continue instead. A thread without a session has nothing to continue and gets its last prompt again. The turn's user message stores an `account_switch` part with both account names as they were, which the transcript draws as a rule in place of the note.
- `Settings.autoSwitchAccount` holds the toggle per agent. When a turn ends `limited` and the toggle is on, the runner picks the target with `roomiest` from `shared/limits.ts`, the same rule as the callout's suggestion: known limits, no window spent for the thread's model, least used. Plan limits come from the runner's one-minute cache. Each thread remembers the accounts it left for a limit until a turn ends any other way, and never picks one of those again, so a chain of limits ends once every account was tried. With no candidate the thread stays limited with its callout.
- `threads.update` no longer takes `accountId`, so an account change always goes through the handoff.
- The renderer decides whether an account is spent from `limits.list`: a window at 100% blocks, and a `model` window blocks only threads whose model id contains its name. The reset shown is the latest among spent windows. Threads of a remote environment show no limit hints, because `limits.list` only reads this machine.

## Out of scope

- Switching automatically by default. Billing a different account is the developer's call, so it is a setting and starts off.
- Switching during a turn. The transcript is still being written.
- A text summary handoff for agents that cannot copy a session. Both agents with accounts can.

## Verification

- `transcripts.test.ts` and `rollouts.test.ts` copy a session with its agent transcripts between temp homes and read its usage from the new one.
- `ipc.integration.test.ts` continues a limited thread on a chosen account with the continue note, and moves one by itself to the account with room left when the setting is on. `shared/limits.test.ts` covers the pick.
- `AgentRunner.integration.test.ts` switches a started thread, checks the copy and the next turn's home and session, clears a limited status, and refuses while a turn runs.
- Prototype on 2026-10-19 with Claude Code 2.1.302 and Codex 0.162.1. Claude resumed a session after its transcript was moved away and copied back. Codex resumed a thread from a rollout copied into an empty `CODEX_HOME`. Neither CLI keeps another index that resume needs.
- With `verify-hinacode` and `HINACODE_MOCK_CLAUDE=usage-limit`, add a second account, hit the limit, and use Continue on the other account. Screenshot the picker hints and the pre-send notice in both themes.
