const PLACEHOLDER = /\{\{\s*([\w$-]+(?:\.[\w$-]+)*)\s*\}\}/g

const lookup = (payload: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (value, key) => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined),
      payload,
    )

const stringify = (value: unknown) => {
  if (value === undefined || value === null) return ""
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

export const renderTemplate = (template: string, payload: unknown) =>
  template.replace(PLACEHOLDER, (_, path: string) => stringify(lookup(payload, path)))

export const slugifyBranch = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .map((segment) => segment.replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, ""))
    .filter((segment) => segment !== "")
    .join("/")
    .slice(0, 80)

const TITLE_LIMIT = 80

export const titleFromPrompt = (prompt: string, fallback: string) => {
  const line = prompt
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "")
  if (line === undefined) return fallback
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT - 1)}…` : line
}
