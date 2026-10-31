# Pull request watch

Status: Building
Date: 2026-10-14

## Problem

A developer running several agents opens a pull request from a thread, then waits. Checks run for minutes. A reviewer answers an hour later. The base branch moves and the pull request starts to conflict. None of that reaches the thread on its own. The developer has to keep glancing at the pull request tab, notice the change, and type "CI failed, fix it" into the thread themselves. The alternative people reach for today is asking the agent to poll `gh` in a loop inside its own turn. That burns tokens on every poll, holds the turn open, and dies with the turn.

hinacode already reads every linked pull request through `gh`. It is the right place to notice a change once and hand it to the thread's agent, so babysitting a pull request becomes something the app does while the developer works on other threads.

## User flow

1. A thread has a linked pull request, from the agent's `link_pull_request` or from checking one out.
2. The developer opens the pull requests panel and clicks **Watch for changes** on the pull request. An agent can do the same with the `watch_pull_request` MCP tool, and the agent instructions tell it to prefer that tool over polling after it opens a pull request.
3. The pull request row and the sidebar thread row show an eye while the watch is live. One click on **Stop watching**, or the `unwatch_pull_request` tool, ends it.
4. Once a minute the main process reads each watched pull request. When something the watch cares about changes, the thread gets a message that starts a new turn, or steers the running one. The message names the pull request, what changed, and what to do about it. The agent fixes the failing check, resolves the conflict, or answers the review, then pushes. That push is a new head, so the next failure or green run is news again.
5. The watch ends by itself when the pull request merges or closes. It also ends after 25 wakes, or after GitHub cannot be read 15 times in a row. Those last two tell the agent why in a final message, so the UI never claims a watch is live when nothing is being read.

The keyboard path is the same as the rest of the panel. The toggle is a button in the pull request detail, reachable by tab, with an accessible name that says which pull request it watches.

## Design

### Data shape

The watch lives on the link, because a watch is meaningless without the thread and pull request it joins. `PullRequestLink` gains one field.

```ts
watch: PullRequestWatch | null

PullRequestWatch = {
  generation: string              // fresh UUID on every start, including after a stop
  events: WatchEventKind[]         // the interest set, never empty
  snapshot: WatchSnapshot | null   // the last state the agent was told about
  wakes: number
  failures: number                 // consecutive failed reads
  lastPolledAt: Timestamp | null
  lastWokeAt: Timestamp | null
}

WatchSnapshot = {
  status: PullRequestStatus
  checks: ChecksStatus | null
  review: ReviewStatus | null
  mergeable: Mergeable
  head: string                     // head commit oid
  failingChecks: string[]          // names, so a second failure is still news
  comments: string[] | null        // ids told about, without the gh account's own; null before comments were watched
}
```

Migration `0013_pull_request_watch` adds one nullable `watch` text column to `pull_request_link`, holding the watch as JSON. It follows the `usage_limit` column on `thread`. A null column is a link nobody watches, so every existing row stays valid and no backfill runs.

Three state rules carry the whole feature.

- **A snapshot only moves when its news is delivered.** Polling builds a fresh snapshot and diffs it against the stored one. The stored snapshot is replaced in the same step that wakes the thread. If the wake cannot happen yet, because the thread waits on an approval or sits at a usage limit, the snapshot stays put and the next poll finds the same news again. Delivery is at least once, and several changes between two polls arrive as one message instead of a queue of stale ones.
- **A generation guards every write.** Each watch start uses a fresh UUID and resets its snapshot. Poll updates compare the stored generation in the same SQL statement that writes the result. A poll that read GitHub before the user stopped or restarted the watch cannot replace or clear the new watch.
- **A new head resets check news.** Failing check names and a green run are compared per head commit. A push makes the same check failing again worth reporting, and makes "checks passed" mean the new code passed, not the old.

### Events

`WatchEventKind` is the set a watch can care about. The default watch cares about all of them. The MCP tool accepts a subset.

| Kind             | Fires when                                                      |
| ---------------- | --------------------------------------------------------------- |
| `checksFailed`   | A check name joins the failing set for the current head         |
| `checksPassed`   | Checks reach passing for a head that was not already passing    |
| `reviewChanged`  | The review decision becomes approved or changes requested       |
| `conflicting`    | GitHub starts reporting the branch as conflicting with its base |
| `mergedOrClosed` | The pull request leaves the open states                         |
| `commented`      | A comment id appears that is not from the gh account itself     |

There is deliberately no event for "checks pending" or "review required". Those are the absence of news. The diff is one pure function in `src/main/services/pullRequestWatch.ts`, taking the stored snapshot, the fresh one, and the interest set, and returning the events to report. The same module renders the wake message from a pull request detail plus its events, so both halves are covered by plain unit tests.

A fresh watch has no snapshot, which the diff treats as a neutral pull request with no checks and no review. Watching a pull request whose checks already failed therefore reports that failure on the first poll, and watching a quiet one stays quiet. Comments are the exception: a fresh watch, and a stored snapshot whose `comments` is null, take the comments already there as told, so starting a watch never replays a pull request's history.

Comment news is keyed on comment ids. The agent posts with the same gh account the watch reads as, so that account's comments are left out, or the agent's own reply would wake it. Bots that keep one report comment edit it in place on every push, and an edit keeps the id, so edits are never news. The wake quotes each new comment with its author, a bot mark, and its location, and frames the quoted text as feedback written by others rather than as instructions from the user.

### Polling and waking

`PullRequestWatcher` is one Effect service beside `AutoArchive`, following its shape. It schedules a sweep every minute, reads each watched link's detail through `GitHub.pullRequestDetail` with a concurrency cap, and runs sweeps under one semaphore so a slow sweep never overlaps the next. Watching needs the head commit, so the detail read gains `headRefOid` and `PullRequestDetail` gains a `head` field.

A wake uses `AgentRunner.steerWhen` with the rendered message and a check of both thread eligibility and watch generation. Active steering checks inside the thread's existing delivery semaphore. An idle turn waits for worktree preparation outside that semaphore, then checks again inside `Worktrees.exclusive`. Its final check follows capture of the working tree and precedes recording that tree as the turn baseline or writing its first message. Rejected news preserves the last accepted turn's baseline and diff. Archiving uses that same worktree lock, so an archive that won the lock cannot be undone by queued news. News remains deferred if the thread has started waiting for an approval or reached a usage limit. Stopping or replacing a watch cancels news that has not passed its final check. Delivery is accepted at that check, so an accepted message can finish arriving after the watch stops. Stop never waits for a provider response. A running turn receives the news as steering input, and an idle thread starts a turn. An archived thread ends its watches without a wake. A thread awaiting approval or stopped at a usage limit keeps its snapshot, which defers the wake to a later sweep without any pending queue to store.

The wake message is news, not a merge decision. It tells the agent what changed and suggests the matching action, such as reading the failing logs or reading the review. It never tells the agent to merge. Whether a green and approved pull request should merge stays with the developer.

`PullRequests` owns persistence. It gains `watch`, `unwatch`, and an internal conditional update the watcher uses to record a poll against a generation. Every change goes out on the existing `thread.pullRequests` push, so the sidebar and the panel learn about a watch the moment it starts, stops, or ends by itself. Watching a pull request that is not linked yet links it first, which is what the panel's branch pull request needs. Unlinking removes the row and its watch with it.

### Entry points

- RPC: `pullRequests.watch` and `pullRequests.unwatch`, both taking `threadId` and `url`. The URL is canonicalized by the same `requirePullRequestUrl` guard as every other pull request call, so it can never reach `gh` as a flag.
- MCP: `watch_pull_request` with an optional `events` subset, and `unwatch_pull_request`. `list_thread_pull_requests` now marks watched links and their wake count. The credential still scopes every call to the calling thread, so an agent can only watch its own thread's pull requests.
- Agent instructions: one new section telling agents to watch instead of polling, and that watch messages arrive as new user input.
- Renderer: a watch toggle in the pull request detail for open pull requests, an eye on the pull request list rows, and an eye next to the pull request number in the sidebar when any of the thread's links is watched. New strings go to both `messages/en.json` and `messages/zh-TW.json`.

### Trust boundaries

Nothing new crosses the network. Reads reuse the user's `gh` login from the home directory, and every response is decoded with the existing schemas before it can wake a thread. Check names and pull request titles come from GitHub and land in the wake message as quoted data lines. They are never instructions the watcher itself follows, and the message frames them as a report. The wake can only start a turn on the thread that owns the link, with that thread's own access mode deciding what the agent may do next.

## Out of scope

- **Comment bodies.** A new review is covered through the review decision, and the wake tells the agent to read the review with `gh`. Reading conversation and review-thread comments on every poll would multiply the GitHub cost of a watch for news the decision already signals.
- **Watching a branch with no pull request.** CI on a push without a pull request has no stable URL to attach a watch to, and the create-pull-request path is one click away.
- **Per-watch poll intervals and quiet hours.** One minute matches the cadence the pull request tab already refreshes at. A watch that needs to be slower can stop and start again.
- **Merging on green.** The watch reports. It never merges, approves, or closes anything.
- **A cheaper fingerprint read.** One detail read per watched pull request per minute is the cost today. If watches ever get numerous enough for that to hurt, a batched status read can gate the detail read without changing the data shape.

## Verification

- `pullRequestWatch.test.ts` covers the diff per event kind, per-head resets, the interest set, fresh-watch behavior, and the wake message text.
- `PullRequestWatcher.integration.test.ts` runs the real services against in-memory SQLite with a mocked `GitHub` and a recording `AgentRunner`. It proves a failing check wakes the thread once, a repeated poll stays quiet, a busy thread defers, a merged pull request ends its watch, a stopped watch drops an in-flight poll even after a replacement starts, and repeated read failures end the watch with a reason.
- `PullRequestWatcher.delivery.integration.test.ts` runs the real runner and SQLite with a scripted provider. It proves that Stop completes while provider steering or a transcript read holds the thread semaphore, and news from the stopped watch is rejected once that semaphore becomes available. It also proves that queued news cannot revive a thread archived at either the thread or worktree lock, or bypass an approval or usage limit reached while delivery waited.
- `AgentRunner.integration.test.ts` blocks a real setup script and turn snapshot. It proves that stopping and replacing a watch at either wait drops the old news without changing the replacement watch, and that an archive completed during preparation stays archived. It also proves that an unwatched wake or pending Stop during capture preserves an existing accepted turn's baseline, diff and messages.
- The MCP integration tests gain a watch round trip through the real HTTP server.
- In the real app with `verify-hinacode`, link a pull request, start a watch from the panel, and confirm the eye appears in the panel and the sidebar. Then stop it and confirm both clear. Screenshot light and dark.
- Full gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
