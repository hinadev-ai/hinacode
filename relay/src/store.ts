import { D1Client } from "@effect/sql-d1"
import { Effect, Schema, String } from "effect"
import { SqlSchema } from "effect/sql"

/** A machine waiting for its owner to approve it, as in OAuth device authorization. */
const Link = Schema.Struct({
  deviceCodeHash: Schema.String,
  userCode: Schema.String,
  environmentId: Schema.String,
  name: Schema.String,
  userId: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number,
})

/** A linked machine and its tunnel. `pairing` is the JSON the machine last published. */
const Host = Schema.Struct({
  id: Schema.String,
  userId: Schema.String,
  environmentId: Schema.String,
  name: Schema.String,
  tunnelId: Schema.NullOr(Schema.String),
  dnsRecordId: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  pairing: Schema.NullOr(Schema.String),
  enabled: Schema.BooleanFromBit,
})
export type Host = typeof Host.Type

const HostOfUser = Schema.Struct({ id: Schema.String, userId: Schema.String })

export const Alert = Schema.Literals(["completed", "needsInput", "failed"])
export type Alert = typeof Alert.Type

/** A phone that receives pushes for the owner it signed in as. */
const Device = Schema.Struct({
  token: Schema.String,
  userId: Schema.String,
  alerts: Schema.fromJsonString(Schema.Array(Alert)),
  seenAt: Schema.Number,
})
export type Device = typeof Device.Type

const makeStore = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client

  return {
    /** Stores a new link and drops the expired ones in one batch. */
    createLink: (link: Omit<typeof Link.Type, "userId">, now: number) =>
      sql.batch([sql`DELETE FROM link WHERE expires_at <= ${now}`, sql`INSERT INTO link ${sql.insert(link)}`]),
    linkByDeviceCode: SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Link,
      execute: (deviceCodeHash) => sql`SELECT * FROM link WHERE device_code_hash = ${deviceCodeHash}`,
    }),
    unexpiredLink: SqlSchema.findOneOption({
      Request: Schema.Struct({ userCode: Schema.String, now: Schema.Number }),
      Result: Link,
      execute: ({ userCode, now }) => sql`SELECT * FROM link WHERE user_code = ${userCode} AND expires_at > ${now}`,
    }),
    approveLink: (deviceCodeHash: string, userId: string) =>
      sql`UPDATE link SET user_id = ${userId} WHERE device_code_hash = ${deviceCodeHash}`.pipe(Effect.asVoid),
    /** Tells whether this call was the one that deleted the link. */
    deleteLink: (deviceCodeHash: string) =>
      sql`DELETE FROM link WHERE device_code_hash = ${deviceCodeHash} RETURNING device_code_hash`.pipe(
        Effect.map((rows) => rows.length > 0),
      ),

    hostByCredential: SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Host,
      execute: (credentialHash) => sql`SELECT * FROM host WHERE credential_hash = ${credentialHash}`,
    }),
    hostOfUser: SqlSchema.findOneOption({
      Request: HostOfUser,
      Result: Host,
      execute: ({ id, userId }) => sql`SELECT * FROM host WHERE id = ${id} AND user_id = ${userId}`,
    }),
    hostsOfUser: SqlSchema.findAll({
      Request: Schema.String,
      Result: Host,
      execute: (userId) => sql`SELECT * FROM host WHERE user_id = ${userId} ORDER BY created_at, id`,
    }),
    /** The machines the owner shows on their devices, once each has published its pairing. */
    shownHostsOfUser: SqlSchema.findAll({
      Request: Schema.String,
      Result: Host,
      execute: (userId) =>
        sql`SELECT * FROM host WHERE user_id = ${userId} AND enabled = 1 AND pairing IS NOT NULL ORDER BY created_at, id`,
    }),
    countOtherHosts: (userId: string, environmentId: string) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM host WHERE user_id = ${userId} AND environment_id != ${environmentId}
      `.pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    /** On a re-link the row keeps its id, tunnel and DNS record, and the new hash revokes the old credential. */
    linkHost: (
      host: Pick<Host, "id" | "userId" | "environmentId" | "name" | "createdAt"> & { credentialHash: string },
    ) =>
      sql`
        INSERT INTO host ${sql.insert(host)}
        ON CONFLICT (user_id, environment_id) DO UPDATE SET name = excluded.name, credential_hash = excluded.credential_hash
      `.pipe(Effect.asVoid),
    setTunnel: (id: string, tunnelId: string) =>
      sql`UPDATE host SET tunnel_id = ${tunnelId} WHERE id = ${id}`.pipe(Effect.asVoid),
    setDnsRecord: (id: string, dnsRecordId: string | null) =>
      sql`UPDATE host SET dns_record_id = ${dnsRecordId} WHERE id = ${id}`.pipe(Effect.asVoid),
    setPairing: (id: string, pairing: string) =>
      sql`UPDATE host SET pairing = ${pairing} WHERE id = ${id}`.pipe(Effect.asVoid),
    /** Tells whether the user has a host with this id. */
    setShown: (host: typeof HostOfUser.Type, enabled: boolean) =>
      sql`
        UPDATE host SET enabled = ${enabled ? 1 : 0} WHERE id = ${host.id} AND user_id = ${host.userId} RETURNING id
      `.pipe(Effect.map((rows) => rows.length > 0)),
    deleteHost: (id: string) => sql`DELETE FROM host WHERE id = ${id}`.pipe(Effect.asVoid),

    /** The owner token's hash after its first rotation. */
    ownerTokenHash: SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ tokenHash: Schema.String }),
      execute: () => sql`SELECT token_hash FROM owner WHERE id = 1`,
    }),
    /** Rotating the owner token also drops every device, which registers again after signing in. */
    setOwnerTokenHash: (tokenHash: string) =>
      sql.batch([
        sql`
          INSERT INTO owner ${sql.insert({ id: 1, tokenHash })}
          ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash
        `,
        sql`DELETE FROM device`,
      ]),

    putDevice: (device: Device) =>
      sql`
        INSERT INTO device ${sql.insert({ ...device, alerts: JSON.stringify(device.alerts) })}
        ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, alerts = excluded.alerts, seen_at = excluded.seen_at
      `.pipe(Effect.asVoid),
    deleteDevice: (token: string, userId: string) =>
      sql`DELETE FROM device WHERE token = ${token} AND user_id = ${userId}`.pipe(Effect.asVoid),
    /** The user's devices registered since `seenSince`, after dropping the older ones in the same batch. */
    devicesOfUser: (userId: string, seenSince: number) =>
      sql
        .batch([
          sql`DELETE FROM device WHERE user_id = ${userId} AND seen_at < ${seenSince}`,
          sql`SELECT * FROM device WHERE user_id = ${userId} ORDER BY token`,
        ])
        .pipe(Effect.flatMap(([, rows]) => Schema.decodeUnknownEffect(Schema.Array(Device))(rows))),
    deleteDevices: (tokens: ReadonlyArray<string>) =>
      sql`DELETE FROM device WHERE ${sql.in("token", tokens)}`.pipe(Effect.asVoid),
  }
})

export type Store = Effect.Success<typeof makeStore>

/** Runs `use` with the store on this request's D1 binding. Columns are snake_case in SQL and camelCase here. */
export const runStore = <A, E>(db: D1Database, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    makeStore.pipe(
      Effect.flatMap(use),
      Effect.provide(
        D1Client.layer({ db, transformQueryNames: String.camelToSnake, transformResultNames: String.snakeToCamel }),
      ),
    ),
  )
