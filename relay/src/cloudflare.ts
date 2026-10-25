import { Option, Schema } from "effect"

export type Fetch = (input: URL, init: RequestInit) => Promise<Response>

/** A Cloudflare call that failed. `message` is a sentence the relay returns as its 502 body. */
export class CloudflareError extends Error {}

const API = "https://api.cloudflare.com/client/v4"

const Envelope = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Struct({ code: Schema.Number, message: Schema.String })),
  result: Schema.optionalKey(Schema.Unknown),
})
const decodeEnvelope = Schema.decodeUnknownOption(Envelope)

const WithId = Schema.Struct({ id: Schema.String })
const Records = Schema.Array(Schema.Struct({ id: Schema.String, content: Schema.String }))

const GONE = Symbol("gone")

const cname = (name: string, content: string) => ({ type: "CNAME", name, content, proxied: true, ttl: 1 })

export interface Cloudflare {
  findTunnel(name: string): Promise<string | null>
  createTunnel(name: string): Promise<string>
  putIngress(tunnelId: string, hostname: string, origin: string): Promise<void>
  findCname(hostname: string): Promise<{ id: string; content: string } | null>
  createCname(hostname: string, content: string): Promise<string>
  updateCname(recordId: string, hostname: string, content: string): Promise<void>
  tunnelToken(tunnelId: string): Promise<string>
  /** Deletes the record. One that is already gone counts as deleted. */
  deleteRecord(recordId: string): Promise<void>
  /** Deletes the tunnel and its connections. One that is already gone counts as deleted. */
  deleteTunnel(tunnelId: string): Promise<void>
}

export interface CloudflareConfig {
  readonly apiToken: string
  readonly accountId: string
  readonly zoneId: string
}

export const makeCloudflare = (fetch: Fetch, config: CloudflareConfig): Cloudflare => {
  const account = `/accounts/${config.accountId}`
  const zone = `/zones/${config.zoneId}`

  /** `action` finishes the sentence "Cloudflare could not ...". */
  const send = async (action: string, method: string, path: string, body?: unknown) => {
    let response: Response
    try {
      response = await fetch(new URL(`${API}${path}`), {
        method,
        headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    } catch {
      throw new CloudflareError(`Cannot reach Cloudflare to ${action}.`)
    }
    if (response.status === 404) return GONE
    const envelope = decodeEnvelope(await response.json().catch(() => undefined))
    if (Option.isNone(envelope)) {
      throw new CloudflareError(`Cloudflare answered HTTP ${response.status} when asked to ${action}.`)
    }
    if (!response.ok || !envelope.value.success) {
      const reason = envelope.value.errors.map((error) => error.message).join("; ") || `HTTP ${response.status}`
      throw new CloudflareError(`Cloudflare could not ${action}: ${reason}.`)
    }
    return envelope.value.result
  }

  const call = async <A>(
    result: Schema.Decoder<A>,
    action: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<A> => {
    const answer = await send(action, method, path, body)
    if (answer === GONE) throw new CloudflareError(`Cloudflare could not ${action}: not found.`)
    const decoded = Schema.decodeUnknownOption(result)(answer)
    if (Option.isNone(decoded)) {
      throw new CloudflareError(`Cloudflare answered in an unexpected shape when asked to ${action}.`)
    }
    return decoded.value
  }

  return {
    async findTunnel(name) {
      const query = new URLSearchParams({ name, is_deleted: "false" })
      const tunnels = await call(Schema.Array(WithId), "look up the tunnel", "GET", `${account}/cfd_tunnel?${query}`)
      return tunnels[0]?.id ?? null
    },
    async createTunnel(name) {
      const tunnel = await call(WithId, "create the tunnel", "POST", `${account}/cfd_tunnel`, {
        name,
        config_src: "cloudflare",
      })
      return tunnel.id
    },
    async putIngress(tunnelId, hostname, origin) {
      await call(
        Schema.Unknown,
        "route the tunnel to the machine",
        "PUT",
        `${account}/cfd_tunnel/${tunnelId}/configurations`,
        { config: { ingress: [{ hostname, service: origin, originRequest: {} }, { service: "http_status:404" }] } },
      )
    },
    async findCname(hostname) {
      const query = new URLSearchParams({ type: "CNAME", name: hostname })
      const records = await call(Records, `look up the DNS record ${hostname}`, "GET", `${zone}/dns_records?${query}`)
      return records[0] ?? null
    },
    async createCname(hostname, content) {
      const record = await call(
        WithId,
        `create the DNS record ${hostname}`,
        "POST",
        `${zone}/dns_records`,
        cname(hostname, content),
      )
      return record.id
    },
    async updateCname(recordId, hostname, content) {
      await call(
        Schema.Unknown,
        `update the DNS record ${hostname}`,
        "PATCH",
        `${zone}/dns_records/${recordId}`,
        cname(hostname, content),
      )
    },
    tunnelToken: (tunnelId) =>
      call(Schema.String, "issue the connector token", "GET", `${account}/cfd_tunnel/${tunnelId}/token`),
    async deleteRecord(recordId) {
      await send("delete the DNS record", "DELETE", `${zone}/dns_records/${recordId}`)
    },
    async deleteTunnel(tunnelId) {
      await send("delete the tunnel", "DELETE", `${account}/cfd_tunnel/${tunnelId}?cascade=true`)
    },
  }
}
