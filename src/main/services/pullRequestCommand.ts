const PULL_REQUEST_COMMAND =
  /\bgh\b[^\n;&|]*\bpr\s+(merge|close|reopen|ready)\b|\bgh\s+api\b[^\n;&|]*\bpulls\b|\bglab\b[^\n;&|]*\bmr\s+(merge|close|reopen)\b|\bgit\b[^\n;&|]*\bpush\b/

const strings = (value: unknown): ReadonlyArray<string> => {
  if (typeof value === "string") return [value]
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings)
  return []
}

export const touchesPullRequest = (input: unknown): boolean =>
  strings(input).some((text) => PULL_REQUEST_COMMAND.test(text))
