# Switch agents mid-thread

Status: Shipped
Date: 2026-10-28

## Problem

A thread is locked to its agent after its first message. When Claude hits its plan limit halfway through a task, or a developer wants Codex to review what Claude wrote, the only way forward is a new thread and a pasted summary. The worktree, the pull request links and the transcript stay behind in the old thread.

## User flow

1. The developer opens the model picker on an idle thread that has already run turns. Every agent's models are listed, as they are before the first message.
2. They pick a Codex model. The transcript gets a rule, "Switched from Claude Code to Codex".
3. They send the next message. Codex starts a new session and gets the conversation so far as a transcript ahead of the message, so it can pick up the task.
4. Later turns resume the Codex session as usual. Switching back to Claude later works the same way and carries the Codex turns too.

The picker lists only the thread's own agent while a turn runs, and the runner refuses a switch until the turn ends.

## Design

- `MessagePart` gains `agent_switch { from, to }`. `AgentRunner.switchAgent` writes it as a completed assistant message of its own when a started thread changes agent. The rule is the notice, and it also tells the next turn which agent ran before.
- `Threads.update` no longer refuses an agent change on a started thread. Changing the agent clears `providerSessionId`, since a session id belongs to one agent, and moves a `limited` thread back to idle, because the limit was the old agent's.
- The rpc `threads.update` sends agent changes through `AgentRunner.switchAgent`, which runs under the thread's lock and refuses while a turn is in flight, like `switchAccount`.
- `handoffPrompt({ messages, from, to, prompt })` in `src/main/agents/handoff.ts` is the one adapter between agents. HinaCode already stores every agent's transcript in the same `Message` shape, so the adapter is a pure function from that shape to text. It renders text, tool calls with a short input, file edits and attachments with their staged path, and leaves out reasoning and tool output. It keeps the most recent messages within a character budget and says how many older ones it left out.
- The runner calls it when a turn starts on a started thread with no session. The text goes ahead of the prompt in `RunTurnInput.prompt` only. The stored user message stays what the developer typed, and the new session keeps the handoff in its own history, so later resumes need nothing more. The same path covers a first turn that failed before its session was bound.
- The desktop transcript and the phone render the rule. The context ring hides until the new agent reports its own window. The MCP `read_thread` tool renders `[agent switched: claude → codex]`.

## Out of scope

- Summarizing the history with a model before the handoff. The transcript costs no extra model call and is deterministic, and the new agent can compact it by itself.
- Importing the history into the new agent's native session format. Each agent keeps a private format, and the transcript reaches all three the same way.
- Token usage across agents. The usage panel reads the current session, so it starts again from the switch.

## Verification

- `handoff.test.ts` covers the rendered transcript, the budget and the note on left-out messages.
- `AgentRunner.integration.test.ts` switches a started thread from Claude to Codex with the mock agents, checks the rule, the cleared session and the handoff the next turn sends, and checks that a running thread refuses.
- With `verify-hinacode`: tell Claude a codeword, switch to Codex in the picker, ask Codex for the codeword, and screenshot the rule above its answer.
