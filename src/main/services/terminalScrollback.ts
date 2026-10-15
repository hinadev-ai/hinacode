/** UTF-8 size of a code point. A lone surrogate counts as the 3-byte replacement character. */
const utf8Size = (code: number) => (code < 0x80 ? 1 : code < 0x800 ? 2 : code > 0xffff ? 4 : 3)

const utf16LengthForUtf8Bytes = (text: string, bytes: number) => {
  let chars = 0
  for (let size = 0; size < bytes && chars < text.length;) {
    const code = text.codePointAt(chars) ?? 0
    size += utf8Size(code)
    chars += code > 0xffff ? 2 : 1
  }
  return chars
}

/**
 * The newest output of one terminal session, bounded in UTF-8 bytes like the scrollback it feeds. Positions are
 * UTF-16 offsets from the session's first character, so a client can slice JavaScript strings with them.
 */
export class TerminalScrollback {
  readonly #budget: number
  readonly #chunks: Array<string> = []
  #bytes = 0
  #startOffset = 0
  /** Characters received so far, which is also the offset of the next one. */
  end = 0

  constructor(budget: number) {
    this.#budget = budget
  }

  append(data: string) {
    this.#chunks.push(data)
    this.#bytes += Buffer.byteLength(data)
    this.end += data.length
    while (this.#bytes > this.#budget) {
      const first = this.#chunks[0] ?? ""
      const dropped = first.slice(0, utf16LengthForUtf8Bytes(first, this.#bytes - this.#budget))
      if (dropped.length === first.length) this.#chunks.shift()
      else this.#chunks[0] = first.slice(dropped.length)
      this.#bytes -= Buffer.byteLength(dropped)
      this.#startOffset += dropped.length
    }
  }

  /** Output from `since`, or from the oldest kept character when `since` is older. `offset` is where `data` starts. */
  from(since: number): { readonly offset: number; readonly data: string } {
    const offset = Math.min(Math.max(since, this.#startOffset), this.end)
    let skip = offset - this.#startOffset
    const parts: Array<string> = []
    for (const chunk of this.#chunks) {
      if (skip >= chunk.length) skip -= chunk.length
      else {
        parts.push(chunk.slice(skip))
        skip = 0
      }
    }
    return { offset, data: parts.join("") }
  }
}
