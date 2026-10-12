/** At most 1 MiB of UTF-16 text before a terminal screen has initialized. */
export const MAX_BACKLOG_CHARS = 512 * 1024

/** Output received before the terminal has a parser to accept it. */
export class TerminalBacklog {
  readonly #chunks: Array<string> = []

  append(data: string) {
    this.#chunks.push(data)
  }

  drain(): { readonly chunks: Array<string>; readonly truncated: boolean } {
    return { chunks: this.#chunks.splice(0), truncated: false }
  }
}
