const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i

/**
 * Turns what was typed in the address field into an http(s) URL, or null. A bare port or a local host gets
 * `http://` as dev servers expect, anything else that looks like a host gets `https://`.
 */
export const browserUrl = (input: string): string | null => {
  const typed = input.trim()
  const port = /^:?(\d{2,5})(\/.*)?$/.exec(typed)
  const candidate = port
    ? `http://localhost:${port[1]}${port[2] ?? ""}`
    : /^[a-z][a-z\d+.-]*:\/\//i.test(typed)
      ? typed
      : LOCAL_HOST.test(typed)
        ? `http://${typed}`
        : /^[^\s/]+\.[^\s/]+/.test(typed)
          ? `https://${typed}`
          : null
  const url = candidate === null ? null : URL.parse(candidate)
  return url && (url.protocol === "http:" || url.protocol === "https:") ? url.href : null
}
