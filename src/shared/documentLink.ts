const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"])
const SCHEME = /^[a-z][a-z\d+.-]*:/i

export const linkHref = (text: string): string | null => {
  const trimmed = text.trim()
  if (trimmed === "" || /\s/.test(trimmed)) return null
  const candidate = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null
    if (url.protocol !== "mailto:" && !url.hostname.includes(".") && url.hostname !== "localhost") return null
    return SCHEME.test(trimmed) ? trimmed : candidate
  } catch {
    return null
  }
}
