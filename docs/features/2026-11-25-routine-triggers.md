# Routine triggers

Status: Building
Date: 2026-11-25

## Problem

A routine starts a thread on a clock, from its webhook or by hand. Work also arrives where people talk: a co-worker asks in a Slack thread, someone comments on a GitHub issue, a Linear issue is assigned. Today the developer copies that into HinaCode, and copies the answer back.

The removed automations polled each service, and the pollers carried most of the failure modes. An earlier Slack design avoided polling but was built for Slack alone: its own link column, its own reply tool and its own permission rule. Each new service would have repeated all three.

## User flow

1. The developer opens a routine and picks a trigger: the event, who may fire it, where it may come from, and an optional phrase the text must contain.
2. An allowed person causes that event. The routine starts a thread with its prompt and the event quoted as data.
3. The agent works under the thread's access mode and answers with the `reply` tool, which posts to the place the event came from.
4. A later event in the same Slack thread, GitHub issue, pull request or Linear issue reaches the same thread. A running turn is steered and an idle thread starts a turn.
5. Every arrival shows in the routine's run history with its thread.

## Design

### One rule, one normalized event

A trigger is part of the routine, so one row answers what starts the agent, who may start it, which agent runs and where it answers. Every source turns its own payload into one shape before any rule sees it. Matching is then one pure function and a new source adds no branch to it.

```ts
type TriggerEvent =
  | "github.issue_opened"
  | "github.pull_request_opened"
  | "github.issue_comment"
  | "github.pull_request_comment"
  | "slack.mention"
  | "linear.comment"
  | "linear.issue_assigned"

type RoutineTrigger = {
  event: TriggerEvent
  fromUsers: [string, ...string[]]
  scopes: string[]
  contains: string | null
  continuation: "conversation" | "new"
}

type ReplyDestination =
  | { source: "github"; repo: string; number: number; url: string }
  | { source: "slack"; channel: string; threadTs: string; url: string }
  | { source: "linear"; issueId: string; url: string }

type Arrival = {
  event: TriggerEvent
  key: string
  sender: string
  scope: string
  text: string
  conversation: string
  destination: ReplyDestination
  context: unknown
}
```

- `Routine.trigger` is `RoutineTrigger | null`. A routine may have a schedule, a trigger, both or neither.
- `fromUsers` cannot be empty and has no wildcard. An event from anyone else matches nothing and leaves no trace. The values are GitHub logins, Slack member ids and Linear user ids.
- `scopes` are repositories as `owner/name`, Slack channel ids or Linear team keys. Empty means any.
- `Arrival.key` names the event itself, such as `github:comment:<id>`. It is the run's `event_key`, so a redelivery starts nothing: the unique index on `(routine_id, event_key)` already exists.
- `Arrival.conversation` names the place, such as `github:acme/api#12` or `slack:C1:1700000000.000100`.
- Every routine whose trigger matches runs. Routines are independent and unordered.

### Conversations

```sql
CREATE TABLE routine_conversation (
  routine_id TEXT NOT NULL REFERENCES routine(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE REFERENCES thread(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  PRIMARY KEY (routine_id, key)
)
```

The row says which thread a place belongs to for one routine, and where that thread answers. With `continuation: "conversation"`, an arrival whose row points at a live thread continues it. Without a row, or when the thread is archived, the arrival starts a thread and writes the row. With `"new"`, every arrival starts a thread, and the row is replaced so the newest thread owns the reply destination.

A thread has at most one row, so `reply` needs no argument beyond the text. Deleting the thread or the routine deletes the row.

Each arrival is a `routine_run` with `source: "event"`. A continued arrival is a started run that points at the existing thread. Trigger runs do not settle earlier runs of the routine, because each conversation is its own piece of work. A scheduled or manual run of the same routine neither settles a conversation's thread nor counts it as the routine's previous run.

### Starting and continuing

`Routines.arrive(arrival)` lists the enabled routines with a trigger, keeps the ones `matches(trigger, arrival)` accepts, and for each claims the run by its event key.

- Start: create the thread, write the conversation row, send the routine's prompt with the arrival quoted.
- Continue: hand the arrival to `AgentRunner.steerWhen`. A running turn is steered and an idle thread starts a turn. When the thread's first turn is still starting, the arrival waits until that turn has started. When that thread fails to start, the run is skipped and the conversation is forgotten, so the next event starts a new thread with the routine's prompt. The `when` check runs at the handover and asks again whether the routine is enabled, still matches, still continues conversations and still owns this one. A decline records the run as skipped with the reason.

Arrivals are handled one at a time on a machine. GitHub sends deliveries concurrently, and two events for a new conversation would otherwise each start a thread.

The arrival is quoted as JSON inside the fence `promptWithPayload` already builds. It carries the sender, the text, the link, the source's context and a note that the content is information from outside and not instruction. JSON strings cannot close the fence or forge another field.

### Answering

`reply({ text })` is one MCP tool for every source. It reads the calling thread's conversation row and posts to that destination only, so an agent cannot choose where to post. A thread without a row gets an error. It is an ordinary tool call, so a Supervised thread shows the text for approval before anything is posted.

A reply posted through the developer's own account would arrive back as an event from an allowed sender. Each source marks or records what it posts and drops its own echoes. A GitHub reply ends with the hidden marker `<!-- hinacode -->`, and a comment that holds it is never an arrival.

### Sources

Events are pushed, never polled.

| Source | Arrives by                                                                     | Verified by                                             | Replies through    |
| ------ | ------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------ |
| GitHub | `POST /hooks/github` on the routine webhook listener                           | `X-Hub-Signature-256` with the machine's webhook secret | `gh`               |
| Slack  | Socket Mode with the developer's own Slack app, a connection the machine dials | The app token that opens the socket                     | `chat.postMessage` |
| Linear | `POST /hooks/linear` on the same listener                                      | `Linear-Signature` with a Linear webhook secret         | The Linear API key |

A source is a decoder from its payload to an `Arrival`, plus a `post(destination, text)`. The listener, the secret, `gh` and the Linear key already exist.

### Slack

The developer creates their own Slack app from a manifest HinaCode links to, and saves its app token and bot token in Settings. The machine dials Slack over Socket Mode while both tokens are stored, so Slack needs no listening port and no relay.

- The event is `slack.mention`: someone mentions the bot in a channel it was invited to. `fromUsers` holds Slack member ids and `scopes` holds channel ids.
- There is no pairing step and no owner. The trigger's `fromUsers` is the only audience, the same rule as GitHub.
- The conversation is the Slack thread, `slack:<channel>:<thread_ts>`. A mention outside a thread starts one under itself. Only mentions arrive, so a thread message that does not mention the bot does nothing.
- A mention inside a thread carries the thread's earlier messages as `context`, at most the last 20, because the question usually points at them. They are quoted data like every other context.
- The event key is `slack:<channel>:<ts>`, so a redelivered envelope starts nothing.
- When a mention starts or continues a run, the bot adds an `eyes` reaction to it, so the person sees that it was taken.
- `reply` posts with `chat.postMessage` into the thread as Markdown, which Slack caps at 12000 characters. A message the bot wrote carries a `bot_id` and is never an arrival.
- The thread is read only when a routine's trigger matches the mention, in pages of 200 messages, at most five pages. A longer thread arrives with no context, and so does one Slack will not hand over.
- Mentions are handled one at a time, so two mentions in one Slack thread reach the routine in order.

### Permission

1. Only a sender in `fromUsers` starts or continues a turn. Everything other people wrote is quoted data.
2. The thread's access mode governs the turn, including the `reply` call.
3. `reply` posts only to the place the conversation came from.
4. A webhook needs a valid signature before its body is parsed. An event that matches no routine does nothing.

### Slices

| Slice     | Builds                                                                                        | Check                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1. GitHub | The trigger on a routine, `arrive`, conversations, `reply`, `/hooks/github`, the routine form | A signed issue comment starts one thread, a second continues it, a stranger starts none, `reply` posts |
| 2. Slack  | The Socket Mode connection, the mention decoder, thread context, the reaction, the Slack post | A mention starts a thread and the answer lands in the Slack thread, against a local fake               |
| 3. Linear | `/hooks/linear`, the comment and assignment decoders, the Linear post                         | A signed comment starts a thread and the answer lands on the issue                                     |

## Out of scope

- A wildcard audience.
- Prompt templates. The arrival is appended as data, as a webhook body is.
- Per-routine tool grants beyond `reply`.
- Reaching the listener from the internet. A repository webhook needs the address the developer already exposes for routine webhooks.
- Files and images in a reply.

## Verification

- `routines/triggers.test.ts` holds the matching table and each decoder.
- `Routines.integration.test.ts` runs arrivals against real SQLite and the real runner: start, redelivery, another sender, continue, a declined continue, an archived thread, two routines on one event.
- `webhook` tests cover a missing and a wrong signature and an unknown event.
- `mcp/server.integration.test.ts` covers `reply` for a thread with and without a conversation.
- With `verify-hinacode`: create a routine with a GitHub trigger in the form, post signed deliveries with `webhook.sh`, and watch one thread start and continue.
- `slack/Slack.integration.test.ts` runs the service, `Routines` and the runner against `fakeSlack.ts`: connect, a refused token, disconnect, a mention that starts a thread, another member and channel, a redelivery, a continue with thread context, and the post.
- With `verify-hinacode` and `fake-slack.ts`: connect in Settings, mention the bot, and watch the thread start, continue and answer into the fake.
