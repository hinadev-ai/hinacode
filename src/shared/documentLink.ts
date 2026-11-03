const WEB_PROTOCOLS = new Set(["http:", "https:"])
const SCHEME = /^[a-z][a-z\d+.-]*:\/\//i

export const linkHref = (text: string): string | null => {
  const trimmed = text.trim()
  if (trimmed === "" || /\s/.test(trimmed)) return null
  const candidate = SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(candidate)
    if (!WEB_PROTOCOLS.has(url.protocol) || url.username !== "" || url.password !== "") return null
    if (!url.hostname.includes(".") && url.hostname !== "localhost") return null
    return candidate
  } catch {
    return null
  }
}
