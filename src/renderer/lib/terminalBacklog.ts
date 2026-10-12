/** At most 1 MiB of UTF-16 text before a terminal screen has initialized. */
export const MAX_BACKLOG_CHARS = 512 * 1024

/** Output received before the terminal has a parser to accept it. */
export class TerminalBacklog {
  readonly #chunks: Array<string> = []
  #length = 0
  #truncated = false

  append(data: string) {
    this.#chunks.push(data)
    this.#length += data.length
    while (this.#length > MAX_BACKLOG_CHARS) {
      const first = this.#chunks.shift()
      if (first === undefined) break
      const excess = this.#length - MAX_BACKLOG_CHARS
      if (first.length > excess) this.#chunks.unshift(first.slice(excess))
      this.#length -= Math.min(first.length, excess)
      this.#truncated = true
    }
  }

  drain(): { readonly chunks: Array<string>; readonly truncated: boolean } {
    const replay = { chunks: this.#chunks.splice(0), truncated: this.#truncated }
    this.#length = 0
    this.#truncated = false
    return replay
  }
}
