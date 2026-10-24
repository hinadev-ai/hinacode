# Relay machines: sign in once, see every machine

Status: Building
Date: 2026-10-24

## Problem

A developer with a home server, an agent VM and two workstations links each one to the relay, then pairs the phone, the iPad and the laptop with each of them: up to twelve QR scans, repeated after every token rotation. The relay already knows every machine the developer linked, but no device can ask it.

## User flow

1. Each machine is linked to the relay once, as in `2026-10-24-relay.md`. From then on it publishes its own pairing (direct addresses, port, token) to the relay, and again whenever one of them changes.
2. On the relay page, under **Your machines**, each machine has **Show on my devices**, on by default.
3. On a device, sign in to the relay with the owner token once: Settings > Environments on the desktop, Settings > Relay on the phone. Every machine shown appears, named, and connects through its relay hostname or its direct addresses.
4. Turning **Show on my devices** off, or removing the machine, drops it from every signed-in device at its next sync. A machine paired by QR code stays, whatever the relay says.
5. A machine that rotates its token publishes the new one, and signed-in devices pick it up at their next sync.

Devices sync when they sign in, when they start, every five minutes on the desktop, and on **Sync now**.

## Design

This is T3 Code's T3 Connect shape (an account that lists the machines, devices that sign in to it) without its credential minting, because the relay has one owner. See [ADR 0021](../adr/0021-the-relay-holds-each-machines-pairing.md).

### Data shape

What a device receives is the pairing a QR code carries, plus the machine's identity, so both clients reuse the path a scanned pairing takes.

```ts
// src/shared/relayMachines.ts
RelayMachine = {
  environmentId: string // the machine's own id, the key both clients already store
  name: string
  pairing: { hosts: NonEmpty<string>; port: number; token: string; relay: string } // a PairingTarget
}

// Where a client's entry came from. A sync adds, refreshes and drops "relay" entries only.
EntrySource = "pairing" | "relay"
```

Relay D1 (`relay/migrations/0003_machines.sql`):

```sql
ALTER TABLE host ADD COLUMN pairing TEXT; -- JSON { hosts, port, token } the machine last published, null until then
ALTER TABLE host ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1; -- Show on my devices
```

Desktop SQLite (migration `0022_environment_source`): `environment.source TEXT NOT NULL DEFAULT 'pairing'`. The owner token is the secret `relay.ownerToken`; the service URL is the machine's relay service, `HINACODE_RELAY_URL` or `https://relay.hinacode.app`.

Phone: `StoredServer.source`, absent in older entries and read as `pairing`. The account is `{ serviceUrl, ownerToken }` in SecureStore under `hinacode.relayAccount`.

### Relay service

| Method and path         | Caller         | Does                                                                                  |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `PUT /v1/host/pairing`  | machine bearer | `{ hosts, port, token }`, stored on the machine's row                                 |
| `GET /v1/machines`      | owner          | `{ machines: RelayMachine[] }`, shown machines that published a pairing, `no-store`   |
| `GET /v1/hosts`         | owner          | Adds `enabled` and `published` to each machine, for the page                          |
| `PATCH /v1/hosts/:id`   | owner          | `{ enabled }`                                                                         |

A hidden machine's pairing never leaves the relay. Its tunnel keeps running, so a device that paired with it by QR code still reaches it.

### Machine

`Relay` publishes `{ hosts, port, token }` from `RemoteAccess.pairing` after linking, when the connector starts, after a token rotation, and every ten minutes, but calls the service only when the pairing differs from the last one it published. The setting row `relay.tunnel` keeps a SHA-256 of that pairing as `published`. A failed publish is logged and retried at the next trigger; it never holds up `cloudflared`.

### Clients

`planRelaySync(entries, machines, selfId)` in `src/shared/relayMachines.ts` decides for both clients: every listed machine except this one, with a usable pairing, is added or refreshed, and a `relay` entry the list no longer has is dropped. A `pairing` entry for a listed machine gets the fresher address, port, relay and token, and keeps its name and its source.

- **Desktop.** `RelayAccount` service (`src/main/services/RelayAccount.ts`) with `relayAccount.status`, `relayAccount.signIn({ ownerToken })`, `relayAccount.signOut` and `relayAccount.sync`, all routed to the client and desktop-only, each answering `RelayAccountStatus`. It hands the list to `Environments.syncRelay`, which writes rows without probing, since the relay already named the machine. Signing out drops the `relay` rows.
- **Phone.** `apps/mobile/src/lib/relay-account.ts` fetches the list and applies the plan to the stored servers. Settings gets a Relay section.

A 401 from `GET /v1/machines` (the owner token was rotated) keeps every entry and asks the developer to sign in again.

## Out of scope

- Per-device credentials and revoking one device. Every signed-in device holds the owner token, so a lost device means rotating it and signing the others in again. Clerk sign-in replaces this before anyone else uses the relay.
- Minting short-lived credentials on each machine, as T3 Code does, so the relay never holds a pairing token. ADR 0021 says when to switch.
- Hiding a machine from one device only.
- Turning a hidden machine's tunnel off.

## Verification

- `relay/test/app.test.ts`: a published pairing appears in `GET /v1/machines` with its hostname as `relay`; a hidden or unpublished machine does not; only the owner can list or toggle, and only the machine can publish.
- `src/main/remote/relay.integration.test.ts`: the host publishes after linking, again after `rotateToken`, and not again when nothing changed.
- `src/shared/relayMachines.test.ts`: the plan skips this machine and unusable pairings, never drops a `pairing` entry, and drops a `relay` entry the list lost.
- `src/main/services/Environments.integration.test.ts`: `syncRelay` adds rows without a probe, refreshes a hand-paired row's token, and drops a hidden machine's row.
- By hand against the deployed relay: link a throwaway `hinacode serve`, sign a desktop instance in, see it under Environments and open its projects; hide it on the relay page, sync, and see it gone. The phone does the same on the emulator.
