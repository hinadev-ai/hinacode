const PULL_REQUEST_COMMAND =
  /\bgh\s+pr\s+(merge|close|reopen|ready)\b|\bgh\s+api\b.*\bpulls\b|\bglab\s+mr\s+(merge|close|reopen)\b|\bgit\s+push\b/

export const touchesPullRequest = (input: unknown): boolean => PULL_REQUEST_COMMAND.test(JSON.stringify(input) ?? "")
