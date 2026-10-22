# Desktop environments: every machine in one window

Status: Building
Date: 2026-10-15

## Problem

`hinacode serve` (`2026-10-14-remote-clouds.md`) runs agents on an always-on machine, but only the phone can drive it. The developer at a laptop cannot use the desktop UI on the cloud's threads. Settings make it worse: models, accounts, archive rules and the worktree root belong to the machine the agents run on, yet the desktop has one settings page that only edits the laptop.

The job hinacode does is to show which agent needs a human. A thread waiting for approval on the home server needs the developer exactly as much as one on the laptop, so a cloud cannot live behind a mode switch.

This is slice 4 of the remote clouds design, moved ahead of slices 2 and 3 because it is the one the developer feels first.

## Prior art, and what we do differently

- **T3 Code** merges every environment into one sidebar and puts a quiet machine icon on remote threads. It pays for that with `(environmentId, id)` references through the whole client, a connection registry and supervisor of about 2,300 lines, several routes per machine, DPoP and about 17 auth scopes. Its keybindings live on the server.
- **Orca** also merges hosts into one sidebar, with section headers per host, but keeps a separate "Active Server" that decides where some actions go. Hosts are addressed three ways (name, `runtime:<id>`, `ssh:<id>`), and pairing tokens sit in a plaintext JSON file.
- **hinacode** merges too, with no active environment, no section per machine, one group per repository, and no environment-scoped references in the renderer. Thread, project, worktree, terminal and automation ids are already UUIDs, so main can route a call by who owns the id. The renderer names an environment only where the user is choosing one: adding a project, and the environment settings picker. Tokens stay in `safeStorage`. Keybindings, theme and language stay on the desktop.

## User flow

1. Settings, Environments, Add environment. Paste the `hinacode://connect` URL the daemon printed. hinacode connects once, reads the cloud's own id and name, and lists it with its status. Pasting a new URL for a cloud already listed (after `--rotate-token`, or a new address) updates that entry instead of adding a second one. Pasting this desktop's own URL is refused, since its threads would show twice.
2. The sidebar lists every machine's projects together, this machine's first, with no section per machine. Projects whose `origin` is the same GitHub repository share one group, so `hinacode` on the laptop and `hinacode` on the home server are one entry with both machines' threads. A cloud icon marks each thread that runs on a cloud, and replaces the folder on a group that lives only on clouds. The icon's label names the machine. While the cloud is not connected the icon is crossed out, and the label adds its state: `Connecting`, `Offline, last seen 4 min ago`, `Pair again` or `Update hinacode on home-server`. The last two need the user, so the icon turns amber. Threads that need the user read at full contrast wherever they run, as they do today.
3. Add project asks where it lives, defaulting to this machine. For a cloud, type a path on that machine or a GitHub repository to clone there; Browse is hidden because it would open a folder on this machine.
4. New thread in a project runs where the project lives. In a group that spans machines, New thread starts on the first connected machine, and the composer's environment picker moves the thread to another one until its first message. The project menu lists each machine's actions under its name. Send a message and the agent runs on the cloud; its events stream into the thread view, and notifications fire as they do for local threads.
5. Settings has two groups. **App** (General, Appearance, Keybindings, Notifications, Environments) is this desktop. **Environment** (Models, Archive, Workspace, Integrations, Automations, Remote, Experimental) starts with an environment picker, `Editing settings for home-server`, and every page in the group reads and writes that machine.
6. When a cloud drops, its projects and threads stay listed as last seen, dimmed, and actions on them fail with `home-server is offline`. It reconnects on its own. A refused token or protocol version stops retrying and says what to do.

## Design

### Data

```ts
// src/shared/domain.ts
ClientSettings    = { locale, keybindings, appearance, notifications }          // this desktop
Settings          = { defaultModel, modelPresets, defaultAccount, automations,  // one environment
                      remote, textGenerationModel, defaultAccessMode, archive,
                      experimental, worktreeRoot }
Environment       = { id, name, host, port, createdAt }   // id is the cloud's own id
EnvironmentStatus = "connecting" | "connected" | "offline" | "unauthorized" | "incompatible"
Project           = { ...today, environmentId?: string,      // set by this desktop on a cloud's projects
                      repository?: string }                  // "owner/name", from the owning machine's origin
```

- Both settings structs keep their rows in the `setting` table; their keys never overlap. A cloud only reads `Settings`. The rpc names `settings.get` and `settings.set` stay, so the phone protocol does not change.
- Every hinacode data directory gets an id once, the setting row `environment.id`, and its `ready` frame gains an optional `environment: { id, name }` (name is the hostname). The phone ignores it. The desktop keys its `environment` table (migration 0015) by that id, so re-pairing converges on one row.
- The pairing token is the secret `environment.<id>.token` in `Secrets`. It never reaches the renderer.
- `Project.environmentId` is absent for this machine. Main stamps it on every project a cloud returns, so the renderer can mark a cloud's projects and learn a thread's environment from its project.
- `Project.repository` is the GitHub repository of the project's `origin`, lower-cased as `owner/name`, followed by the root's folder inside the repository when the project is a subfolder (`acme/mono/apps/web`). Each machine reads it from its own checkout in the `projects.list` handler, so a cloud's projects arrive with theirs. `Projects.list` itself stays a plain query, because the git-root check calls it on every `git.*` call.

### Routing

`src/main/environments/routes.ts` holds `routes: Record<RpcMethod, Route>`. [ADR 0017](../adr/0017-route-desktop-calls-by-owner.md) records why routing is by owner and not by an active environment. The `Record` type makes every new rpc method choose a route before it compiles.

```ts
type Route =
  | { to: "client" } // this desktop answers: window, dialogs, its settings
  | { to: "all" } // every environment, results concatenated
  | { to: "owner"; entity: Entity; key: string } // payload[key] is an id main has seen
  | { to: "named" } // the call names its environment; this machine when it does not
type Entity = "thread" | "project" | "worktree" | "terminal" | "automation" | "request" | "root" | "stream"
```

- **`all`** (`projects.list`, `threads.list`, `worktrees.list`, `pullRequests.all`, `search.threads`) asks every environment in parallel. A cloud that is not connected contributes its last answer to the same call from memory, so its projects and threads stay listed.
- **`owner`** looks the id up in an in-memory owner index. Main fills it from every answer and push it relays: lists and creates teach thread, project, worktree, terminal and automation ids; `worktree.path` and `project.rootPath` teach roots for `git.*` and `fs.*`; approval, question and secret requests in thread events teach request ids. An id nobody has claimed belongs to this machine, which is also what every id is with no cloud paired. Roots are paths, not UUIDs, so a cloud project at the same path as one on this desktop takes its `git.*` and `fs.*` calls; Mac and Linux home directories keep that rare.
- **`named`** reads an `environment` field on the ipc envelope, next to `method` and `payload`. Only `settings.*`, `accounts.*`, `agents.account`, `models.list`, `secrets.*`, `github.*`, `vm.host`, `remote.*`, `projects.create`, `projects.clone`, `ports.kill`, `automations.list` and `limits.list` are named, and the renderer passes it from the settings picker, the project dialog, or the thread in view. GitHub calls go where the thread's `gh` is signed in. Plan limits are named so the status bar shows this machine's accounts once instead of every machine's copy of the same subscription.
- Pending calls survive a dropped link and calls made while reconnecting queue in order. Reads rerun on reconnect; mutations reuse a call key when the cloud advertises support. A call times out after a total minute offline. See `2026-10-16-resilient-remote.md`.

### Connections

`services/Environments.ts` keeps one `CloudConnection` per paired cloud, all live at once, and publishes `environment.status`.

- The protocol is the phone's: `auth` first, `ready`, then `call` frames matched by `id`, and `event` frames decoded with `ServerFrame` before they reach the window.
- A `ready` whose `version` is not `REMOTE_PROTOCOL_VERSION` closes the socket as `incompatible`, and the cloud icon's label names the side to update. Close codes 4001 and 4002 are `unauthorized`. These and an incompatible version stop retrying until the user pairs again.
- Anything else reconnects with jittered backoff from 0.5 s to 60 s, reset after a minute connected. A ping every 10 s and no pong for 25 s closes a half-open socket, which a tunnel or a sleeping laptop leaves behind.
- Cloud events go to the window only. Phones paired with this desktop keep seeing this desktop's events only.

### Renderer

- `clientSettingsAtom` holds language, appearance, keybindings and notifications. `settingsAtom` becomes a family keyed by environment.
- The settings page registry has `scope: "app" | "environment"`. General keeps language; the worktree root moves to a new Workspace page.
- `groupProjects` (`lib/projectGroups.ts`) folds `projects.list` into groups: a project joins the earlier group with its `repository` unless that group already holds a project on its machine, so two clones on one machine stay apart. A project without a `repository` is a group of one.
- `Sidebar` renders one entry per group. Its threads are the members' threads in one list, reorderable as one. `CloudMark` leads the meta line of a cloud's threads, and replaces the folder icon on a group with no project on this machine. The project dialog has a `Where` picker.
- `call(method, payload, { environment })` passes the environment for named routes.

### Trust boundary

The pairing URL crosses from the renderer to main once, in `environments.add`, decoded with `parsePairingUrl`. Every frame from a cloud is decoded with `ServerFrame`, the schema the phone uses. Tokens stay in main and `safeStorage`. The new rpc methods are in `desktopOnlyMethods`, so a phone paired with this desktop cannot add environments or change its settings.

## Out of scope

- Moving a project or a thread to another machine. A project, its threads and worktrees stay where they were created; grouping only lists them together.
- Grouping by anything but a GitHub `origin`, and a per-project switch to keep a repository's machines apart (T3 has one). They wait for someone who needs them.
- Methods a cloud refuses as desktop-only: attachments, the live file explorer, the Tiny VM screen and the cloud's own pairing page answer `DesktopOnly` on a cloud's threads.
- Remembering a cloud's last state across a desktop restart, scoped tokens, the relay (slice 3), and updating a cloud from the desktop.

## Verification

- `src/main/services/Environments.integration.test.ts` runs against a real SQLite file and a real remote listener on a loopback port. It covers pairing, re-pairing converging on one row, a wrong token as `unauthorized`, forwarding by owner and by name, the merged `threads.list`, a cloud's push reaching the window and not the phone sinks, and pending calls surviving a cloud reconnect.
- `src/main/environments/routes.test.ts` checks that every route's `key` is a field of that method's request.
- `src/renderer/lib/projectGroups.test.ts` covers grouping: one group across machines, one project per machine per group, and no grouping without a repository. `Projects.integration.test.ts` reads `repository` from real temp repositories with an SSH and an HTTPS `origin`, a subfolder project and no `origin`.
- By hand, the desktop on macOS (its own `HINACODE_USER_DATA`) pairs with the VM's cloud. It lists the cloud's project and threads with a cloud icon among this machine's, adds a project on the cloud, sends a message there, and the turn runs on the VM. It also edits that cloud's default model, and crosses out the cloud icon after the daemon stops. Screenshots in light and dark.
