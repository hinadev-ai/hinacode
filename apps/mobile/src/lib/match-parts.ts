export interface MatchPart {
  readonly text: string
  readonly match: boolean
  readonly start: number
}

/**
 * Splits `text` around every case-insensitive occurrence of each word in `query`, so a result can draw the words
 * the developer typed in another weight. Overlapping words merge into one match.
 */
export function matchParts(text: string, query: string): MatchPart[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "")
  const haystack = text.toLowerCase()
  // Lowercasing changes the length of a few scripts, which would put the match at the wrong offset.
  if (words.length === 0 || haystack.length !== text.length) return [{ text, match: false, start: 0 }]

  const matched = new Array<boolean>(text.length).fill(false)
  for (const word of words)
    for (let at = haystack.indexOf(word); at !== -1; at = haystack.indexOf(word, at + 1))
      matched.fill(true, at, at + word.length)

  const parts: MatchPart[] = []
  for (let start = 0; start < text.length; ) {
    let end = start + 1
    while (end < text.length && matched[end] === matched[start]) end += 1
    parts.push({ text: text.slice(start, end), match: matched[start] === true, start })
    start = end
  }
  return parts.length === 0 ? [{ text, match: false, start: 0 }] : parts
}
