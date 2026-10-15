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
 * character is shown once. No React Native imports, so Vitest can drive it.
 */
export class TerminalOutput {
  /** The offset just past the last character shown, or null when the screen may not match the session. */
  private written: number | null = null
  private attach: { readonly token: Attach; readonly held: Chunk[] } | null = null

  /** Starts an attach. Output received until it settles is held back, and a newer attach supersedes this one. */
  beginAttach(): Attach {
    const token = { since: this.written }
    this.attach = { token, held: [] }
    return token
  }

  /** Returns what to write for a push, or "" when it is held back or already shown. */
  receive(chunk: Chunk): string {
    if (this.attach !== null) {
      this.attach.held.push(chunk)
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
    // A screen that may not match, or output dropped from the desktop's scrollback, is repainted.
    const text =
      since === null || answer.offset > since ? RESET + answer.data : answer.data.slice(since - answer.offset)
    this.written = answer.offset + answer.data.length
    return text + held.map((chunk) => this.take(chunk)).join("")
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
    this.written = null
  }

  private take({ data, offset }: Chunk): string {
    if (offset === undefined) return data
    const end = offset + data.length
    if (this.written !== null && end <= this.written) return ""
    // A gap means output was lost; the next attach repaints it.
    const skip = this.written === null ? 0 : Math.max(0, this.written - offset)
    this.written = end
    return data.slice(skip)
  }
}
