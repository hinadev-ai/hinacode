# Phone: pair with several servers and pick where work runs

Status: Building
Date: 2026-10-24

## Problem

The phone pairs with exactly one HinaCode, a desktop or a `hinacode serve` cloud. A developer with a laptop and a home server has to Disconnect and pair again to look at the other machine, and while they look at one, a thread waiting for approval on the other is invisible. That is the job HinaCode exists to do, so it cannot hide behind a re-pair.

Pairing with the desktop does not help either. The remote listener answers with plain local `dispatch` (`environments.*` is in `desktopOnlyMethods`), and `Environments` sends a cloud's pushes to the desktop's windows only. A phone has to pair with each server directly.

This is slice 4 of `2026-10-14-remote-clouds.md` for the phone. The desktop built the same thing for its window in `2026-10-15-desktop-environments.md`, and this follows it.

## User flow

1. A phone that was paired before this change opens on its threads as before. Its pairing became the first entry of the server list.
2. Settings, Servers lists each paired server by name with its status. Add server opens the pairing screen (scan or paste, as for the first pairing). The new server shows up in the list and its projects and threads join the home lists. Tap a server to see its addresses, reconnect it, pair it again or forget it.
3. The home lists show every server's projects and threads together. There is no active server. With more than one server paired, each thread and project names its server in its meta line, quietly. A server that is not connected keeps its threads listed as last seen, dimmed, its mark crossed out.
4. Add project asks which server the project lives on, defaulting to the first connected one.
5. New thread in a project runs on that project's server. In the new-thread sheet, a repository that exists on several servers is one row; tapping it asks which server the thread runs on.
6. A thread on a server that is offline says so above its chat, while threads on the other servers keep working.
7. Forgetting the last server returns to the pairing screen.

## Design

### Stored list

`lib/stored-target.ts` stores `hinacode.servers`, a JSON array of `{ id, name, environmentId, hosts, port, token }` in the secure store (`localStorage` on web), decoded with a schema. Entries that fail to decode are dropped one by one, so one bad entry does not unpair the rest.

- `id` is made by the phone when it pairs, so routing has a key before the first handshake.
- `name` and `environmentId` come from the server's `ready` frame (`environment: { id, name }`), on its first handshake. Until then the row shows the first host. The name is kept after that, like the desktop keeps a typed name.
- Pairing a URL whose port matches a server and whose hosts overlap it updates that entry's hosts and token instead of adding one. That is Pair again after `--rotate-token`. A handshake whose `environmentId` another entry already has drops the older entry, so the same machine paired at a new address converges on one row.
- The old single pairing under `hinacode.connection` is read once, becomes the first entry, and is deleted.

### Connections and routing

`lib/connection.ts` keeps one `Transport` per server, all connected at once, each with its own backoff, heartbeat and pending calls. `useConnection` carries `servers` with each one's status, error, features and handshake count, plus aggregates for code that only asks "is anything connected": `status` is the best of all servers, `generation` counts every handshake, `features` holds what every connected server understands.

`call(method, payload, { server }?)` keeps its signature, and routes by the table the desktop uses. `routes.ts` and `owners.ts` move from `src/main/environments/` to `src/shared/`, since both are pure, and the phone and desktop main import the same table.

- **`owner`**: the server whose answers or pushes named the id (`learnFromAnswer`, `learnFromPush`). With one server paired, every call goes there. With several, an id no server has claimed yet waits until each server has answered a list or gone offline, then fails as not found.
- **`all`**: asked of every connected server at once and concatenated. A server that is not connected, or does not answer within 5 seconds, contributes its last answer to the same call, so its threads stay listed. Each answer to `projects.*` is stamped with `environmentId` set to the server's phone-side id, which is how a thread finds its server (through its project) and how the UI marks it.
- **`named`** and **`client`**: the server the call names, else the first connected server. The phone names one for `projects.create`, `projects.clone`, and its settings page.

Every server's pushes go through the same listeners, so the stores are unchanged: thread, project and worktree ids are UUIDs, and the merged lists are keyed by id. Any handshake reloads the lists, since pushes from that server were missed.

### UI

- `components/server-mark.tsx`: the server's name with a computer icon, crossed out and dimmed when not connected. It renders nothing with one server paired. The thread row, the project header and the new-thread sheet use it.
- `app/server/new.tsx` reuses the pairing form inside the paired stack.
- The thread screen's offline notice reads the thread's server instead of the aggregate.

## Out of scope

- Renaming a server. The name is the server's hostname, as the desktop shows it before the user types one.
- Remembering a server's last answers across an app restart. A server that is offline when the app starts lists nothing until it connects, as on the desktop.
- Moving a thread or a project between servers. Git is the sync.
- Picking a server for GitHub calls, model lists and other named calls outside settings and Add project. They go to the first connected server, which is right whenever every machine has the same `gh` login and agents.
- Pairing with a desktop and seeing its clouds through it. The phone pairs with each server directly.

## Verification

- `src/shared/routes.test.ts` checks every owner route's key against its method's request, for both apps.
- `apps/mobile/src/lib/stored-target.test.ts` covers decoding the list, dropping one bad entry, the migration from `hinacode.connection`, and merging a re-pair into its entry.
- `apps/mobile/src/lib/connection.test.ts` runs two transports against fake sockets: a merged `threads.list`, a call routed to the thread's owner, a server going offline while the other keeps answering and its last list staying, and a named call.
- By hand: two isolated HinaCode instances with seeded demo projects, each with its remote listener on its own port, paired with the phone's web build at 390x844. Upgrade from a stored single pairing, add the second server, see the merged list, create a project and a thread on each, approve a command on each, stop one instance while the other keeps working, and forget a server.
