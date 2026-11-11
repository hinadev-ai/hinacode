# Artifact feedback: comments and whiteboards

Status: Building
Date: 2026-11-08

## Problem

Artifacts flow one way. The agent publishes, the developer reads, and the only way back is typing into the composer. Two things the developer wants to say have no home:

- "This sentence is wrong" about one line of a document. Today they copy the line into the composer and explain where it is.
- "What about this?" about a box they sketched. There is nowhere to sketch, so architecture talk stays prose.

And when the developer does answer, nothing tells the agent. "Ask agent" only fills the draft.

## User flow

### Comments on a document

1. The developer selects text in a document and presses Comment in the selection menu. They type a comment, optionally with `@` to mention another thread, and press Enter.
2. The quoted text gets a highlight. The comment goes to the thread that owns the document straight away, or to the mentioned threads instead. A running turn gets it as steering. An idle thread starts a turn.
3. The agent answers with `comment_on_artifact`. The reply shows in the comment thread, and the thread reads "Waiting on you" until the developer replies or resolves it.
4. The agent can also start a comment on a quote, to ask the developer something about a line it wrote.
5. The Comments button in the document footer lists every comment, open first. A comment whose text was deleted stays in the list, marked as detached, with its quote.

### Whiteboard

1. The agent calls `publish_whiteboard` with shapes, text and arrows in Excalidraw's skeleton form. The Artifacts panel opens an Excalidraw canvas. The developer can also start an empty one from New, then Whiteboard, in the Artifacts panel.
2. The developer draws on it. Edits save on their own, like a document.
3. The developer selects what they drew and presses Ask. They type a question. The question, the selected elements' text and an image of the selection go to the thread.
4. The agent calls `publish_whiteboard` again with only the elements it adds or changes, placed next to the selection, and replies on the comment.
5. The Comments button in the footer lists the questions and answers. Clicking one selects its elements and scrolls to them.

## Design

### Why the harness makes this simple

Feedback needs a way to wake the agent. A standalone tool would poll files and inject hooks into each harness. HinaCode already owns the thread: `AgentRunner.steer` gives text to a running turn or starts one on an idle thread, which is what `send_to_thread` uses. Every developer action here is one steer. A burst of comments coalesces by itself, because the first starts a turn and the rest steer into it. There is no unread state, no read receipt and no watcher process.

### Data shape

Feedback lives beside the versions in `<root>/<id>/feedback.json`, like document images, so a new version keeps its comments. Only the store writes it, under the artifact's lock.

```ts
type CommentAuthor = { kind: "developer" } | { kind: "agent"; threadId?: string }

type CommentMessage = { id: string; author: CommentAuthor; body: string; createdAt: string }

type CommentAnchor =
  | { kind: "artifact" }
  | { kind: "text"; quote: string; prefix: string; suffix: string }
  | { kind: "elements"; ids: string[] }

type ArtifactComment = {
  id: string
  anchor: CommentAnchor
  resolved: boolean
  messages: [CommentMessage, ...CommentMessage[]]
  createdAt: string
  updatedAt: string
}

type ArtifactFeedback = { comments: ArtifactComment[] }
```

- A comment cannot exist without a message, so an empty thread is unrepresentable.
- "Waiting on you" is derived: open, and the last message is the agent's. Nothing stores it, so it cannot go stale.
- A text anchor is a quote with up to 32 characters of context on each side. Documents are Markdown, and the agent rewrites the whole file on every publish, so position or block ids would not survive an agent's edit. The quote does whenever the sentence does. When the quote is no longer in the document, the comment is detached, not deleted. The editor matches against rendered text, but an agent quotes the Markdown it read, so a quote that is not found is tried again without its inline syntax (emphasis, strikethrough, code spans, links and escapes).
- An elements anchor names Excalidraw element ids, which survive both sides' edits.
- The agent cannot edit or delete a developer's message.

Artifact kinds grow to `"page" | "document" | "whiteboard"`.

### Mentions

A comment body is Markdown and may hold `@thread:<id>` tokens, the composer's mention syntax, rendered the same way. Delivery goes to the mentioned threads when there are any, and to the owning thread otherwise. Mentioning a thread is how the developer asks a different agent about this artifact. That agent sees the artifact id, reads it with `read_artifact`, and replies as itself. A reply records its thread, so the comment shows who answered.

Delivery runs on the machine that holds the artifact, so a mention reaches only threads on that machine in the owning thread's project, the rule `send_to_thread` follows for the project. The picker offers only those threads. Mentions that reach nobody fall back to the owner, so a comment is never saved without a reader. A comment to an archived thread unarchives it first, as a message from the composer does.

An artifact from another harness has no owning thread. Its comments are saved, and only mentions deliver.

A comment is saved and delivered in two steps, so quitting between them must not lose it. The message is saved with `undelivered: true` in the same `feedback.json` write, and `markDelivered` clears it after every recipient has it, or when the developer archived the thread. A failed delivery keeps the mark. At the next start, ArtifactFeedback hands over every message still marked, reading each artifact on its own so one unreadable `feedback.json` does not stop the rest. Each delivery records its message in the thread under an id made from the comment message and the thread. Delivery passes `AgentRunner.steerWhen` and `AgentRunner.queue` a `when` that is false once the thread's transcript or queue has that id, and the runner checks it under the thread's lock, in a steer, in a turn's start and before queueing, so a quit after delivery does not send it twice. One window stays: a quit after the agent CLI accepts a steer and before the transcript row is written delivers the comment again at the next start. A turn's end skips a queued message whose id the transcript already has. A recovered whiteboard comment loses its selection image, because `feedback.json` does not keep attachments. The element descriptions in the prompt still name the selection.

### What the agent receives

`artifactFeedbackPrompt` in `src/shared/artifactFeedback.ts` writes the steer text, so it is one pure function with tests:

```
Comment on document "Release Plan" (artifact k3n9..., comment c_4f2a):
> the migration runs before the deploy
Should this be after? The deploy creates the table.

Answer with comment_on_artifact, and change the document if needed.
```

A whiteboard question adds the selected elements' text and an image attachment of the selection.

### Tools

- `comment_on_artifact({ id, comment?, quote?, elements?, body, resolve? })` replies to a comment, or starts one anchored on a quote or elements, or on the whole artifact. `resolve: true` resolves it after the reply.
- `read_artifact` on an artifact with feedback appends its open comments, so an agent after compaction sees what is waiting.
- `publish_whiteboard({ id?, title?, revision?, elements, remove?, auto_open? })` merges by element id: new ids are added, existing ids replaced, `remove` deletes. A merge cannot lose the developer's other elements, so it needs no conflict handling. `read_artifact` on a whiteboard summarizes the scene: each element's id, type, text and bounds, and arrows as `a -> b`.

### Whiteboard storage

The entry is `scene.excalidraw`, Excalidraw's own file format. The agent writes skeleton elements, the short form `convertToExcalidrawElements` accepts. The renderer completes skeletons when it loads the scene, in memory, and writes them back only with the developer's next edit, the same rule documents follow. The developer's save sends the whole scene with its base revision. On a conflict the renderer reconciles its elements with the stored ones by Excalidraw's per-element version and saves again.

Two canvases on the same board, such as the desktop and the web app, must complete a skeleton the same way. A completed shape takes a version above any copy the canvas already held, so the agent's replacement wins on every canvas. Its label is named `<container>:label` rather than a random id, so two canvases do not save two labels.

### rpc and events

- `artifacts.feedback({ id })`, `artifacts.comment({ id, comment?, anchor?, body, attachments? })` and `artifacts.resolveComment({ id, comment, resolved })` route by the artifact's owner, like documents.
- `artifacts.createWhiteboard`, `artifacts.readWhiteboard` and `artifacts.saveWhiteboard` mirror the document trio. `createWhiteboard({ threadId, title })` publishes an empty scene by the developer, owned by the thread, and routes by the thread's owner.
- The watcher sees `feedback.json` change and pushes `artifact.feedback`, whether the developer, an agent or another harness wrote it.

## Out of scope

- Live cursors and simultaneous editing of the same element. The whiteboard merges per element.
- Mentioning a thread on another machine.
- Comments on pages. A page is hostile HTML in a sandboxed frame, and anchoring into it needs a script inside the frame.
- Inline questions with options inside a document.
- The phone app.

## Verification

- `packages/artifacts`: feedback store tests (anchors, replies, resolve, other writers keep their comments) and the whiteboard merge.
- `src/shared/artifactFeedback.test.ts`: prompt text and delivery targets with and without mentions.
- `mcp/server.integration.test.ts`: `comment_on_artifact` through the built-in server records the calling thread.
- The real app with `verify-hinacode`: comment on a document and see the thread start a turn, reply from the mock, resolve. Draw on a whiteboard, ask about a selection.
