# Approval notes

Status: Building
Date: 2026-10-31

## Problem

An approval card offers allow, allow for session and deny, and nothing else. A denial tells the agent only that it was refused, so it guesses why and often asks for the same thing again. "Don't edit that file, change the test instead" cannot be said at the moment it matters.

Typing the redirect into the composer does not help either. A steer sent while the agent waits on an approval goes to the provider in the middle of the tool call. What happens then depends on the provider, and the agent may raise its next request before it reads the message.

## User flow

1. The agent asks to run a command. The approval card shows the command and a note field.
2. The user types "use pnpm, not npm" in the note and presses Deny (or Mod+Enter in the note to deny). The agent receives the denial with that reason and acts on it.
3. The user may also type a note and press Allow. The agent runs the tool, then reads the note as the user's next message.
4. While the card is open, the composer still takes input. Enter queues the message for the next turn, as it always has. Mod+Enter (steer) no longer reaches the agent mid-approval. The message waits in the queue tray, marked as waiting for the approval, and steers the turn as soon as nothing waits on the user. If the turn ends first, it starts the next turn like any queued message.

## Design

The data shape is one optional field on the existing answer.

- `approvals.respond` takes `{ requestId, decision, note? }`. The note is trimmed and dropped when empty.
- `AgentProvider.respondApproval(requestId, decision, note?)` returns whether the note reached the model with the decision itself.
- `QueuedMessage` gains `steer?: true`. A queued message with it steers the running turn once no approval, question or secret request is pending. Without it, a message waits for the turn to end, as before. The queue is a JSON column, so no migration is needed.

Each provider takes the note as far as its protocol allows.

| Provider | Deny with a note | Allow with a note |
|---|---|---|
| Claude | `canUseTool` returns `{ behavior: "deny", message }` with the note in the message. | `PermissionResult` has no message for allow, so the note steers. |
| Codex | `decline` and the MCP elicitation `decline` carry no text, so the note steers. | Steers. |
| Muse | `approval/decide` sends the note as `feedback` when the chosen choice has `acceptsFeedback`. Otherwise it steers. | Same rule. |

A note that the provider did not take goes to the front of the thread's queue with `steer: true`. AgentRunner does this under the thread's lock, so the provider's `approval_resolved` cannot be handled before the note is queued. When `approval_resolved` (or `question_resolved`, `secret_resolved`) leaves the thread with nothing pending, the runner steers every `steer` message in queue order. The note and anything the user typed during the approval arrive in the order they were written, as user messages in the transcript.

`threads.steer` on a turn that waits on the user appends to the queue with `steer: true` instead of calling the provider. Nothing new lives in memory, so a message sent during an approval survives an app restart like any other queued message.

No trust boundary changes. The note is a string decoded by the rpc schema and sent to the same provider the user is already talking to.

## Out of scope

- Escaping an approval loop (get-bb/bb#6667). Deny with a reason is the first lever. Stop already interrupts the turn.
- Auto mode honoring the user's own permission patterns (pingdotgg/t3code#11458). Separate feature.
- Changing what plain Enter does during an approval. It keeps its meaning of "after this turn".

## Verification

- `src/main/agents/claude/approvals.test.ts`: a deny note becomes the deny message; an allow note is reported as not delivered.
- `src/main/agents/muse/approvals.test.ts`: feedback goes out only on choices with `acceptsFeedback`.
- `src/main/services/AgentRunner.integration.test.ts`: a steer during an approval is queued, then steered once the approval resolves; an undelivered note steers ahead of it.
- `src/renderer/components/ApprovalCard.test.ts`: the card renders the note field.
- In the real app with `verify-hinacode`: start a Claude thread in ask mode, have it run a command, deny with a reason, and screenshot the agent acting on the reason.
