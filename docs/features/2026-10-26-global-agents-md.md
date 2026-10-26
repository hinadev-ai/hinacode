# Global AGENTS.md

Status: Building
Date: 2026-10-26

## Problem

A developer who runs Claude Code, Codex and Muse side by side keeps the same personal rules in three places. Claude Code reads `~/.claude/CLAUDE.md`. Codex reads `$CODEX_HOME/AGENTS.md`. Muse keeps its own copy, which its `/rules import` copies once from either of the other two. The files drift, and every change means three edits.

Added accounts make it worse. HinaCode starts an added account with its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (`src/main/agents/claude/index.ts`, `src/main/agents/codex/index.ts`), so the rules in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` never reach those threads.

## User flow

1. The developer opens Settings > Instructions.
2. They write their rules in the "All agents" editor. It takes Markdown, like an `AGENTS.md`.
3. Optionally they add rules only one agent gets, in the Claude Code, Codex or Muse Code field below it.
4. Each field saves when it loses focus. Every new thread, on any account, follows the rules.

## Design

The setting is one object in `Settings` (`src/shared/domain.ts`), stored as one JSON row by the existing setting store. No migration is needed, since a missing row decodes to its default.

```ts
agentsMd: {
  all: string
  claude: string
  codex: string
  muse: string
}
```

Empty strings add nothing. A provider gets `all` then its own entry, joined, inside a `<user-instructions>` block that `agentInstructions` (`src/main/agents/instructions.ts`) appends after HinaCode's own instructions. That string already reaches every provider on every turn:

- Claude Code gets it as `systemPrompt.append`.
- Codex gets it as `developerInstructions` on `thread/start` and `thread/resume`.
- Muse has no developer instructions in MSP, so the text rides in front of each prompt. Muse shows `displayText`, so the user never sees it in the transcript.

An edit reaches new threads. A thread that already started may keep the old rules. Claude Code 2.1.294 records a `prompt_snapshot` of the system prompt in the session transcript and reuses it on `--resume`. Codex ignores `thread/resume` config for a thread it has loaded. Only Muse picks up an edit on the next message. The settings page promises new threads, which holds for all three.

Settings belong to the environment the agents run in, so a paired cloud keeps its own rules.

### Inject, don't write files

We inject the text at session start instead of writing `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and Muse's rules file.

- Writing the files would overwrite rules the user keeps by hand, or need a merge format with markers that the user can break by editing.
- Writing the files would still miss added accounts, unless HinaCode wrote into every account home too.
- Writing the files would change what the CLIs do outside HinaCode, which the user did not ask for.

The cost of injecting is that the rules apply only to threads HinaCode runs. A `claude` or `codex` started in a terminal does not see them. The provider files keep loading as before, so a rule kept in both places reaches the agent twice. The settings page says this, so the user can move a rule instead of copying it.

### Secrets

The text goes into every prompt, so the editor's hint says not to put secrets in it. It is plain settings data, like the tiny VM template, and goes through the normal `settings.get` and `settings.set` rpc. It is never logged.

## Out of scope

- Importing the existing `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md` into the editor. The user can paste them.
- Per-project rules. Projects already have their own `AGENTS.md` and `CLAUDE.md`.
- Applying rules to the one-shot Claude calls that name threads and write pull request guides. They are not agent threads.

## Verification

- `src/main/agents/instructions.test.ts` covers the composition: shared plus per-provider, blank parts dropped, nothing added when both are empty.
- With `verify-hinacode`, set a rule such as "End every reply with the word PINEAPPLE" under All agents and a provider-specific one, then start a Claude Code, a Codex and a Muse Code thread and check each reply follows both.
