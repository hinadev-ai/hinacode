# Rename machines

Status: Shipped
Date: 2026-11-15

## Problem

Every client labels a machine with the name it first learned, usually a hostname such as `KalandeMac-mini.local`. Long names crowd the sidebar badge, the draft heading, the settings picker and the phone's server list. Today the desktop takes a name only when you pair by hand, the phone takes none, and a relay machine keeps whatever the relay says.

## User flow

- Desktop and web: Settings > Connections, `Rename` on the cloud's card, type a name, `Save`. Every place that names the machine shows the new name at once.
- Phone: Settings, tap the server, `Rename`, type a name, `Save`.

## Design

- A name belongs to the client. Each client names a machine once, from the pairing handshake or the relay, and after that only the user changes it. Relay sync no longer overwrites the name of a relay entry, on the desktop (`Environments.syncRelay`) or the phone (`applyRelayMachines`). This removes the one rule that would have clobbered a rename, so no new column or flag is needed.
- Desktop: `environments.rename { id, name }` writes `environment.name` and pushes `environments.changed`. The name is a `MachineName`: trimmed, not empty, at most 80 characters. The shared `RenameDialog` serves accounts and clouds.
- Phone: `renameServer` sets `StoredServer.name`, which is already persisted. The sheet swaps to the shared `RenameForm` that thread rename uses, so Android gets the same input as iOS.
- Web: the relay is the web app's only source of machines, so it keeps renames in `localStorage` and applies them in `start()` before connecting. `environments.rename` saves and reloads, as `relayAccount.sync` already does.

## Out of scope

- Renaming a machine for every client at once. That needs a name the machine publishes through the relay, which the relay does not accept today.
- The desktop's own name. It reads `This machine` locally, and other clients rename it on their side.
- Following a relay rename. A machine that re-links under a new hostname keeps its old name on clients until the user renames it.

## Verification

- `Environments.integration.test.ts` renames a relay cloud and syncs a relay list with another name. `relay-account.test.ts` does the same on the phone. `apps/web/e2e/web.spec.ts` renames a machine in Settings and reloads.
- By hand: a desktop paired with a loopback `hinacode serve`, renamed through the dialog, then restarted. The phone web build paired with the same cloud, renamed in the server sheet, then reloaded.
