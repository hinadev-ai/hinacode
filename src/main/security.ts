const EXTERNAL_PROTOCOLS = new Set(["https:", "http:"])

/** Returns the URL to hand to `shell.openExternal`, or null when the OS must not open it. */
export const externalUrl = (url: string): string | null => {
  const parsed = URL.parse(url)
  return parsed && EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null
}
