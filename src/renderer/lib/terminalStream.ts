import type { TerminalAttachment, TerminalSession } from "../../shared/domain.ts"

interface Screen {
  readonly write: (data: string) => void
  readonly reset: () => void
  readonly exited: (exitCode: number | null) => void
}

type Held = { readonly data: string; readonly offset: number | undefined } | { readonly exitCode: number | null }

export class TerminalStream {
  readonly #screen: Screen
  readonly #fetch: (since: number) => Promise<TerminalAttachment>
  #nextOffset = 0
  #disposed = false
  #exitShown = false
  #held: Array<Held> = []
  #attaching: Promise<TerminalSession | null> | null = null

  constructor(screen: Screen, fetch: (since: number) => Promise<TerminalAttachment>) {
    this.#screen = screen
    this.#fetch = fetch
  }

  data(data: string, offset?: number) {
    if (this.#disposed) return
    if (this.#attaching) this.#held.push({ data, offset })
    else if (offset !== undefined && offset > this.#nextOffset) {
      this.#held.push({ data, offset })
      void this.attach()
    } else this.#write(data, offset)
  }

  exited(exitCode: number | null) {
    if (this.#disposed) return
    if (this.#attaching) return void this.#held.push({ exitCode })
    if (this.#exitShown) return
    this.#exitShown = true
    this.#screen.exited(exitCode)
  }

  dispose() {
    this.#disposed = true
    this.#held = []
  }

  attach(): Promise<TerminalSession | null> {
    if (this.#disposed) return Promise.resolve(null)
    this.#attaching ??= this.#attach()
    return this.#attaching
  }

  async #attach() {
    const since = this.#nextOffset
    const answer = await this.#fetch(since).catch(() => null)
    const session = this.#disposed ? null : (answer?.session ?? null)
    if (!this.#disposed && answer !== null) {
      const { offset, data } = answer
      if (offset !== since) {
        this.#screen.reset()
        this.#exitShown = false
      }
      if (data) this.#screen.write(data)
      this.#nextOffset = offset + data.length
    }
    this.#attaching = null
    for (const held of this.#held.splice(0)) {
      if ("exitCode" in held) this.exited(held.exitCode)
      else if (session) this.data(held.data, held.offset)
      else this.#write(held.data, held.offset)
    }
    if (session?.status === "exited") this.exited(session.exitCode)
    return session
  }

  #write(data: string, offset: number | undefined) {
    if (offset === undefined) return this.#screen.write(data)
    const fresh = data.slice(Math.max(0, this.#nextOffset - offset))
    if (!fresh) return
    this.#nextOffset = offset + data.length
    this.#screen.write(fresh)
  }
}
