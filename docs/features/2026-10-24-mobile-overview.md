# Mobile overview: pull requests and Linear tickets

Status: Building
Date: 2026-10-24

## Problem

Away from the desk, a developer has two questions: which of my pull requests need me, and which Linear tickets are on my plate. The phone answers neither at a glance. Pull request state hides inside each thread's PRs tab, and Linear is not on the phone at all, because the Linear client only exists inside the agents' MCP tools and the automation poller.

## User flow

1. On the home screen (or the iPad sidebar), the developer taps Overview in the header.
2. Pull requests come first, grouped by what they need:
   - **Needs you**: checks failing, changes requested, or conflicts. The row says which.
   - **Open**: everything else that is open or a draft.
   - **Merged**: merged pull requests of threads that are not archived yet.
     Each row shows the state icon, the title, `owner/repo #123`, the checks, and the thread it belongs to. A tap opens the existing PR screen.
3. Linear lists the open tickets assigned to the developer: started first, then by priority. Each row shows the identifier, title, state and priority. A tap offers Open in Linear and Start a thread. Start a thread opens the new-thread sheet; the new thread's composer starts with `ENG-123 Title`, so the agent can read the ticket with its Linear tool.
4. Pull to refresh reads both again.

States: loading, empty, error with retry, and offline (the last loaded lists stay, under a notice). When Linear is empty and the server has no Linear key, the hint says to connect Linear in desktop Settings, Integrations.

## Design

**Linear service.** `services/Linear.ts` owns the Linear client. It reads `linear.apiKey` from `Secrets` and loads `@linear/sdk` on first use (it costs ~30 MB that most sessions never need).

- `client`: the SDK client for this machine's key, or none. The MCP tools and the `linear.issue` poller both use it, so the key lookup and the lazy import live in one place.
- `assignedIssues`: one GraphQL query for the open issues (`state.type` not `completed` or `canceled`) assigned to the key's owner, 50 at most, most recently updated first. The answer is decoded with a schema, since it crosses a network boundary. Empty when there is no key.
- `HINACODE_MOCK_LINEAR=1` swaps in demo tickets and no client, for screenshots and manual testing. It never touches a real workspace.

**rpc.** `linear.issues: Void -> Array<LinearIssue>`, a read, not desktop-only, so the remote listener serves it. `LinearIssue` is `{ id, identifier, title, url, state: { name, type }, priority, updatedAt }`: only what the phone draws or sorts by. Its desktop route is `all`, because each machine may have its own key; a machine without one contributes nothing. The key never leaves the server.

The phone tells "no key" from "no tickets" with the existing `secrets.has({ name: "linear.apiKey" })`, which is also not desktop-only and only answers a boolean.

**Pull requests.** No new rpc. The overview is derived from what the phone already holds: `pullRequests.all` links (loaded on every handshake), the threads store, and the `github.pullRequest` summaries cache (60 seconds). It reads summaries only for links whose thread is not archived, four at a time, so a large history does not fan out into many `gh` processes. Conflicts come from a watched link's snapshot, the only cheap source of `mergeable`; `github.pullRequestDetail` is not used because it also starts a guide. A pull request linked to several threads shows once, under its newest link.

Both lists dedupe by id or URL on the phone, so they stay correct once the phone talks to several servers.

## Out of scope

- Pull requests on the desktop. Its Linear issues page (`routes/linear.tsx`) reads the same rpc and shares `sortIssues` from `src/shared/linear.ts`.
- Conflicts on pull requests nobody watches. Showing them would mean one `gh pr view` with `mergeable` per pull request.
- Pull requests that no thread linked, such as review requests from teammates.
- Changing a ticket's state from the phone.

## Verification

- `services/Linear.test.ts` decodes a Linear answer, returns nothing without a key, and fails on an answer of the wrong shape.
- `ipc.integration.test.ts` remote mode: a paired phone calls `linear.issues` and gets an empty list on a machine without a key.
- `verify-hinacode` with seeded threads, linked pull requests answered by a fake `gh`, and `HINACODE_MOCK_LINEAR=1`; the phone on the web build and the iPhone and iPad simulators.
