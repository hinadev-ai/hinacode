const escapedBackslashOrUnicode = /\\(\\|u([0-9a-fA-F]{4}))/g

export function decodeUnicodeEscapes(text: string): string {
  if (!/^\s*[[{]/.test(text)) return text
  return text.replace(escapedBackslashOrUnicode, (escape, _body: string, hex: string | undefined) => {
    const code = hex === undefined ? 0 : Number.parseInt(hex, 16)
    return code < 0x80 ? escape : String.fromCharCode(code)
  })
}
