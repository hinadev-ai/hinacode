# Mention an artifact

Status: Shipped
Date: 2026-11-10

## Problem

A developer looks at an artifact beside the thread and wants the agent to act on it: fix a chart, follow a plan, compare two reports. The agent knows an artifact only by its id, which the panel never shows, so the developer describes it by title and the agent calls `list_artifacts` and guesses. Asking another thread about an artifact is worse, because that agent never saw it published.

## User flow

1. In the composer, the developer types `@`. The suggestion list shows artifacts by title after terminals and before files, with their kind icon. The thread's own artifacts come first. Picking one inserts `@artifact:<id>`.
2. In the Artifacts panel, right-clicking a row offers Mention in thread and Copy mention. An open artifact has the same Mention in thread as an `@` button in its header. Mention in thread appends `@artifact:<id>` to the draft and focuses the composer. Copy mention puts the token on the clipboard, for another thread or a terminal agent.
3. The sent message shows `@<title>`. Clicking it opens the artifact beside the thread.
4. The agent sees `@artifact:<id>` and calls `read_artifact` with the id. To point the developer at an artifact, it writes the mention in its reply, which renders as the same link.

## Design

`@artifact:<id>` joins `@thread:` and `@terminal:` in `src/shared/mentions.ts`, so the composer highlighter, the message view, `remarkMentions` and the agent instructions pick it up from the same `MENTION` regex. Ids are the 12-character ids the artifact store already hands out.

`read_artifact` reads only the store on the agent's machine. `mentionableArtifacts` therefore offers only artifacts whose `environmentId` matches the thread's project, and the panel hides Mention in thread for the others. Copy mention stays, because the developer may paste it into a thread on that machine.

Renderer: the composer reads `artifactsAtom`, which the panel already loads. `Mention.tsx` renders an artifact as a button that calls `openArtifact`, or as the raw token when the artifact is unknown. The row's context menu requests composer focus in `onOpenChangeComplete`, because Base UI returns focus to the trigger when the menu closes.

## Out of scope

- Links and suggestions on the phone. apps/mobile does not render mentions specially.
- Mentioning a comment or a part of an artifact. Comments already reach the agent with the artifact and comment ids.

## Verification

- With `verify-hinacode`: publish a document through `mcp-call.ts`, use Mention in thread and Copy mention from the panel, pick it from `@` in the composer, send a question on Sonnet, and check that the agent calls `read_artifact` and that the `@<title>` link in its reply opens the document.
- Tests: `mentions.test.ts` (parsing, same-machine filter, suggestion order), `composerSyntax.test.ts` (highlighting known artifacts only) and `MessageList.component.test.tsx` (the link opens the artifact, an unknown id stays plain).
