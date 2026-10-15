import type { TerminalAttachment, TerminalSession } from "../../shared/domain.ts"

interface Screen {
  readonly write: (data: string) => void
  /** Clears the screen and its scrollback. */
  readonly reset: () => void
  readonly exited: (exitCode: number | null) => void
}

type Held = { readonly data: string; readonly offset: number | undefined } | { readonly exitCode: number | null }

/**
 * Puts one session's output on its screen exactly once, in order, from `terminal.data` pushes and `terminal.attach`
 * answers that can overlap or leave gaps around a reconnect.
 */
export class TerminalStream {
  readonly #screen: Screen
  readonly #fetch: (since: number) => Promise<TerminalAttachment>
  /** Offset of the next character the screen expects. */
  #next = 0
  #exitShown = false
  /** Output that arrived while an attach was in flight, applied after its answer. */
  #held: Array<Held> = []
  #attaching: Promise<TerminalSession | null> | null = null

  constructor(screen: Screen, fetch: (since: number) => Promise<TerminalAttachment>) {
    this.#screen = screen
    this.#fetch = fetch
  }

  /** A push. `offset` is missing from clouds older than `terminal.attach`, so such output is written as it comes. */
  data(data: string, offset?: number) {
    if (this.#attaching) this.#held.push({ data, offset })
    else if (offset !== undefined && offset > this.#next) {
      this.#held.push({ data, offset })
      void this.attach()
    } else this.#write(data, offset)
  }

  exited(exitCode: number | null) {
    if (this.#attaching) return void this.#held.push({ exitCode })
    if (this.#exitShown) return
    this.#exitShown = true
    this.#screen.exited(exitCode)
  }

  /** Catches the screen up with the session's kept output. Resolves with the session, or null when attach failed. */
  attach(): Promise<TerminalSession | null> {
    this.#attaching ??= this.#attach()
    return this.#attaching
  }

  async #attach() {
    const since = this.#next
    let session: TerminalSession | null = null
    try {
      const { offset, data, ...answer } = await this.#fetch(since)
      session = answer.session
      if (offset !== since) {
        this.#screen.reset()
        this.#exitShown = false
      }
      if (data) this.#screen.write(data)
      this.#next = offset + data.length
    } catch {
      // A cloud older than terminal.attach, a closed session, or no link. Held output still goes on screen.
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

  /** Writes what the screen does not have yet, accepting a gap. */
  #write(data: string, offset: number | undefined) {
    if (offset === undefined) return this.#screen.write(data)
    const fresh = data.slice(Math.max(0, this.#next - offset))
    if (!fresh) return
    this.#next = offset + data.length
    this.#screen.write(fresh)
  }
}
