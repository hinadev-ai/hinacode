import { D1Client } from "@effect/sql-d1"
import { Effect, Schema, String } from "effect"
import { SqlSchema } from "effect/sql"

const Link = Schema.Struct({
  deviceCodeHash: Schema.String,
  userCode: Schema.String,
  environmentId: Schema.String,
  name: Schema.String,
  userId: Schema.NullOr(Schema.String),
  expiresAt: Schema.Number,
})

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

const makeStore = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client

  return {
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
    setShown: (host: typeof HostOfUser.Type, enabled: boolean) =>
      sql`
        UPDATE host SET enabled = ${enabled ? 1 : 0} WHERE id = ${host.id} AND user_id = ${host.userId} RETURNING id
      `.pipe(Effect.map((rows) => rows.length > 0)),
    deleteHost: (id: string) => sql`DELETE FROM host WHERE id = ${id}`.pipe(Effect.asVoid),

    ownerTokenHash: SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: Schema.Struct({ tokenHash: Schema.String }),
      execute: () => sql`SELECT token_hash FROM owner WHERE id = 1`,
    }),
    setOwnerTokenHash: (tokenHash: string) =>
      sql`
        INSERT INTO owner ${sql.insert({ id: 1, tokenHash })}
        ON CONFLICT (id) DO UPDATE SET token_hash = excluded.token_hash
      `.pipe(Effect.asVoid),
  }
})

export type Store = Effect.Success<typeof makeStore>

export const runStore = <A, E>(db: D1Database, use: (store: Store) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    makeStore.pipe(
      Effect.flatMap(use),
      Effect.provide(
        D1Client.layer({ db, transformQueryNames: String.camelToSnake, transformResultNames: String.snakeToCamel }),
      ),
    ),
  )
