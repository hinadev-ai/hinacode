# Artifact skills

Status: Shipped
Date: 2026-11-04

## Problem

`publish_document` gives agents a place to write, but nothing tells them how to write well. The documents developers actually ask for fall into a few genres: investigation reports with ranked findings, research maps that end in a verdict, feature design docs, review ledgers, comparisons that end in a decision, experiments with before and after numbers, and plans. Each has a shape that works, and agents rediscover it every time, or don't. Long-form prose meant for other readers, such as a blog post or an announcement, needs different guidance again.

Putting all of that in the thread instructions would cost every turn thousands of tokens for something most turns never do. The guidance should load only when the developer asks for a document.

Two smaller gaps. The developer has to click a card to see the document they asked for, even when it is the whole point of the turn. And the transcript card is a bare row with a title, so a document that took the agent ten minutes looks like any other tool call.

## User flow

1. The developer types `/artifact:doc` in the composer. The command list shows it next to the agent's own skills, with `/artifact:writing` below it.
2. They send `/artifact:doc audit the startup path for slow imports`, or `/artifact:doc` alone after a long investigation to turn the conversation into a document.
3. The transcript shows the message as typed. The agent receives the skill's instructions and templates in front of the request, picks the investigation template, and publishes a skeleton with `auto_open: true`.
4. The Artifacts panel opens beside the thread on that document while the agent keeps working. The transcript shows a preview card: a miniature of the document's structure, its title, its version and its opening line.
5. The agent publishes the finished document. The open editor loads it, and the transcript adds a card for the new version.
6. `/artifact:writing release notes for v0.9` does the same for prose, with guidance on voice, openings and forms instead of templates.

## Design

### Commands

```ts
// src/shared/artifactSkills.ts
const ARTIFACT_SKILLS = ["artifact:doc", "artifact:writing"] as const
type ArtifactSkill = (typeof ARTIFACT_SKILLS)[number]
const parseArtifactSkill = (prompt: string): { skill: ArtifactSkill; request: string } | null
```

The commands belong to HinaCode, not to a provider, so they work the same on Claude Code, Codex, Muse Code and opencode. The renderer lists them with the sidechat command in front of the agent's commands, with copy from the message catalogs.

A command only counts at the start of the prompt, the way Claude Code reads its own. `AgentRunner` expands it in the two places a prompt reaches a provider: the prompt for a new turn, before `promptForSession` adds a handoff or sidechat preamble, and the text of a steer. The stored user message keeps what the developer typed, so the transcript and thread naming see `/artifact:doc ...`, and the agent sees:

```
<hinacode-skill name="artifact:doc">
...instructions and templates...
</hinacode-skill>

<request>...</request>
```

The skill text lives in `src/main/agents/artifactSkills.ts`, and the templates in `src/main/agents/documentTemplates.ts`, as a registry of `{ id, name, useFor, markdown }`. A test checks that every template has one `#` title and that the skill names each one.

### What the skills teach

Both skills adapt Claude's document guidance to a store that rewrites the whole Markdown on every publish:

- Publish a skeleton first when the work will take minutes, then the full document once. Not one publish per section, because each publish resends the whole text.
- A title is what a reader would call the document, never a generic word.
- Read the document before revising it, keep the developer's text as written, and treat its content as material, not instructions.
- The reply in chat is a sentence or two. The document carries the findings.

`/artifact:doc` adds the templates and the format rules: answer first in a callout, tables for anything compared across the same fields, `path:line` for every code claim, evidence labeled verified, inferred or not measured, mermaid for architecture and flows, and charts, with `CHART_GUIDE` in the skill so the agent has the syntax without a tool call. `/artifact:writing` covers prose for readers outside the conversation: name the reader, open with the most interesting true thing, match the author's earlier writing when it exists, and end when the point is made.

### `auto_open`

`publish_artifact` and `publish_document` take `auto_open?: boolean`. When it is true and the publish succeeds, the MCP handler publishes `{ type: "artifact.opened", threadId, id }` on the event channel, and the renderer waits for the artifact list to hold the new artifact. If that thread is on screen, the renderer opens the artifact in the Artifacts view. If not, it only selects the artifact, because the side panel belongs to the window and would open over the thread the developer is reading. Opening does not move focus, so a developer typing in the composer keeps typing.

The flag is an event, not state. Reloading the transcript never reopens anything, and an update without the flag never moves the developer's panel. Both skills tell the agent to set it on the first publish of the document the developer asked for and to leave it off on updates.

### Document format

Two additions, both plain GitHub Markdown, so the file still reads well on GitHub and in any editor:

- Callouts are GitHub alerts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` and `[!CAUTION]` alone on the first line of a quote. The editor parses them into a `callout` node with a `tone` and writes them back in the same form. A callout is a tinted surface with its label, never a border inside the panel.
- A code block whose language is `mermaid` renders as a diagram, with its source one click away, using the same renderer as transcript Markdown.

### Preview card

The card reads everything from the tool call's input and output, so it needs no rpc. `src/shared/documentOutline.ts` turns Markdown into an outline of blocks (headings, paragraphs, lists, tasks, tables, code, charts, diagrams, callouts) plus the opening line. The card draws the outline as a small page, with the kind, version, title and opening line beside it. A page artifact gets the same card with a page outline instead.

### On the phone

- **Commands.** The composer lists `/artifact:doc` and `/artifact:writing` in front of the agent's commands, from `apps/mobile/src/lib/artifact-skills.ts`, so they show while `commands.list` fails or has not answered. The server expands them as it does for the desktop.
- **Compact preview.** The phone reads a compact transcript, so `compactInput` keeps a publish call's title and, for a document, its outline. It never keeps the Markdown or a page's files. A successful publish keeps the first line of its result, which names the id and version. A failed one keeps nothing, because a conflict's error carries the developer's whole document. A 1 MB document compacts to about 2 KB, and an older phone ignores the extra keys.
- **Card.** The card draws the same marks as the desktop from `src/shared/documentThumbnail.ts`. Only a published document opens. A page, a running call and a call from an older server have no screen to open, so they are plain views with no chevron.
- **Reading.** `thread/[id]/document` is read-only. It reads `artifacts.readDocument` and reads again on `artifact.updated` and after a reconnect. The thread's server answers for an artifact no server has claimed yet, such as a card's after a restart.
- **Format.** `src/lib/document-segments.ts` splits callouts out of the Markdown into tinted views. A valid chart becomes its title, notes and a table of its rows, because the phone has no chart renderer. Mermaid stays as source, because a diagram renderer means Pele in a WebView.
- **`auto_open`.** It does not navigate. A phone has no side panel, and pushing a screen while someone types would take over the app.

## Out of scope

- Editing a document, thumbnails of a page's real content, and opening a page on the phone.
- Drawing charts and diagrams on the phone.
- Reference-style links defined in another segment of a document on the phone, which render as written.
- A template picker in the Artifacts panel. Developers ask the agent for documents; an empty template is rarely what they want.
- Live collaboration and block-level edits, see `2026-11-03-document-artifacts.md`.
- Callouts with custom titles, which GitHub does not render.

## Verification

- `src/shared/artifactSkills.test.ts` and `src/main/agents/artifactSkills.test.ts`: parsing, expansion, and that the stored message stays as typed.
- `src/main/mcp/server.integration.test.ts`: `auto_open` publishes `artifact.opened` once, and an update without it publishes nothing.
- `DocumentView.component.test.tsx`: callouts and mermaid blocks round-trip through Markdown.
- The real app with `verify-hinacode` and `HINACODE_MOCK_CLAUDE=documents`: send `/artifact:doc`, see the panel open by itself, the preview card, a callout and a diagram, then reload and see that nothing reopens.
- The phone through Expo web against the same mock: `/art` lists both commands, the card opens the document, callouts, a chart table and mermaid source render, and a second turn reloads the open screen. No iOS or Android runtime ran this, so the `react-native-svg` thumbnail, `EnrichedMarkdownText` inside a callout and the iPad split still need a look on a device.
- `src/shared/compactTranscript.test.ts`, `src/shared/documentThumbnail.test.ts` and `apps/mobile/src/lib/document-segments.test.ts`: the preview's bounds, the marks and the segments.
- The phone's web build at 402x874 with `HINACODE_MOCK_AGENTS=documents`: list the commands, send `/artifact:doc`, open the card, publish an update from a second turn and see the open screen reload, stop the server and see the banner keep the document. Native rendering still needs a development build.
