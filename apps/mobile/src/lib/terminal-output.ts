/** Clears the screen and scrollback before output that does not continue what is shown. */
export const RESET = "\x1bc"

interface Chunk {
  readonly data: string
  /** Position of the first character in the session's output. Absent from older desktops. */
  readonly offset?: number
}

export interface Attach {
  readonly since: number | null
}

/**
 * Decides what to write to the screen from a session's output pushes and `terminal.attach` answers, so each
 * character is shown once.
 */
export class TerminalOutput {
  private nextOffset: number | null = null
  private gap: Chunk[] = []
  private attach: { readonly token: Attach; readonly held: Chunk[] } | null = null

  /** Starts an attach. Output received until it settles is held back, and a newer attach supersedes this one. */
  beginAttach(): Attach {
    const token = { since: this.nextOffset }
    this.attach = { token, held: this.gap.splice(0) }
    return token
  }

  get needsAttach() {
    return this.gap.length > 0
  }

  /** Returns what to write for a push, or "" when it is held back or already shown. */
  receive(chunk: Chunk): string {
    if (this.attach !== null) {
      this.attach.held.push(chunk)
      return ""
    }
    if (this.gap.length > 0 || (this.nextOffset !== null && chunk.offset !== undefined && chunk.offset > this.nextOffset)) {
      this.gap.push(chunk)
      return ""
    }
    return this.take(chunk)
  }

  /** Returns what to write for an attach answer plus any output held back meanwhile, or null when superseded. */
  attached(token: Attach, answer: { readonly offset: number; readonly data: string }): string | null {
    if (this.attach?.token !== token) return null
    const { held } = this.attach
    this.attach = null
    const { since } = token
    const needsRepaint = since === null || answer.offset > since
    const text = needsRepaint ? RESET + answer.data : answer.data.slice(since - answer.offset)
    this.nextOffset = answer.offset + answer.data.length
    return text + held.map((chunk) => this.receive(chunk)).join("")
  }

  /** Returns the output held back for a failed attach, or null when superseded. */
  attachFailed(token: Attach): string | null {
    if (this.attach?.token !== token) return null
    const { held } = this.attach
    this.attach = null
    return held.map((chunk) => this.take(chunk)).join("")
  }

  /** The screen could not show some output, so the next attach repaints from the start of the scrollback. */
  lost() {
    this.nextOffset = null
  }

  private take({ data, offset }: Chunk): string {
    if (offset === undefined) return data
    const end = offset + data.length
    if (this.nextOffset !== null && end <= this.nextOffset) return ""
    const skip = this.nextOffset === null ? 0 : Math.max(0, this.nextOffset - offset)
    this.nextOffset = end
    return data.slice(skip)
  }
}
