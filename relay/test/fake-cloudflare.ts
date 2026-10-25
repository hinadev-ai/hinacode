import type { Fetch } from "../src/app"

interface Record {
  id: string
  name: string
  content: string
  proxied: boolean
}

const envelope = (result: unknown, status = 200) =>
  Response.json({ success: status < 400, errors: [], messages: [], result }, { status })

const notFound = () =>
  Response.json({ success: false, errors: [{ code: 1003, message: "Not found" }], result: null }, { status: 404 })

/** The parts of the Cloudflare API the relay calls, kept in memory. */
export class FakeCloudflare {
  readonly tunnels = new Map<string, { id: string; name: string }>()
  readonly configurations = new Map<string, unknown>()
  readonly records = new Map<string, Record>()
  readonly calls: string[] = []
  private failure: { method: string; path: RegExp } | null = null
  private nextId = 1

  /** Makes the next call matching `method` and `path` answer with a Cloudflare error. */
  failNext(method: string, path: RegExp) {
    this.failure = { method, path }
  }

  readonly fetch: Fetch = async (input, init) => {
    const method = init.method ?? "GET"
    const path = input.pathname.replace("/client/v4", "")
    this.calls.push(`${method} ${path}`)
    if (input.origin !== "https://api.cloudflare.com") throw new Error(`Unexpected host ${input.origin}`)
    if (new Headers(init.headers).get("Authorization") !== "Bearer test-api-token") {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      )
    }
    if (this.failure && this.failure.method === method && this.failure.path.test(path)) {
      this.failure = null
      return Response.json(
        { success: false, errors: [{ code: 1000, message: "Injected failure" }], result: null },
        { status: 500 },
      )
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    const query = input.searchParams
    const id = () => `id${this.nextId++}`

    let match: RegExpExecArray | null
    if (method === "GET" && path === "/accounts/account/cfd_tunnel") {
      return envelope([...this.tunnels.values()].filter((tunnel) => tunnel.name === query.get("name")))
    }
    if (method === "POST" && path === "/accounts/account/cfd_tunnel") {
      const tunnel = { id: `tunnel-${id()}`, name: body.name }
      this.tunnels.set(tunnel.id, tunnel)
      return envelope(tunnel)
    }
    if ((match = /^\/accounts\/account\/cfd_tunnel\/([^/]+)\/configurations$/.exec(path)) && method === "PUT") {
      if (!this.tunnels.has(match[1]!)) return notFound()
      this.configurations.set(match[1]!, body)
      return envelope({ tunnel_id: match[1] })
    }
    if ((match = /^\/accounts\/account\/cfd_tunnel\/([^/]+)\/token$/.exec(path)) && method === "GET") {
      return this.tunnels.has(match[1]!) ? envelope(`token-${match[1]}`) : notFound()
    }
    if ((match = /^\/accounts\/account\/cfd_tunnel\/([^/]+)$/.exec(path)) && method === "DELETE") {
      if (!this.tunnels.delete(match[1]!)) return notFound()
      this.configurations.delete(match[1]!)
      return envelope({ id: match[1] })
    }
    if (method === "GET" && path === "/zones/zone/dns_records") {
      return envelope(
        [...this.records.values()].filter(
          (record) => record.name === query.get("name") && query.get("type") === "CNAME",
        ),
      )
    }
    if (method === "POST" && path === "/zones/zone/dns_records") {
      const record = { id: `record-${id()}`, name: body.name, content: body.content, proxied: body.proxied }
      this.records.set(record.id, record)
      return envelope(record)
    }
    if ((match = /^\/zones\/zone\/dns_records\/([^/]+)$/.exec(path))) {
      const record = this.records.get(match[1]!)
      if (!record) return notFound()
      if (method === "PATCH") {
        Object.assign(record, { content: body.content, proxied: body.proxied })
        return envelope(record)
      }
      if (method === "DELETE") {
        this.records.delete(record.id)
        return envelope({ id: record.id })
      }
    }
    throw new Error(`Unexpected Cloudflare call ${method} ${path}`)
  }
}
