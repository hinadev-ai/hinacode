const OWN_TOOL_PREFIX = /^(?:mcp__hinacode__|hinacode[_/])/

export const ownToolName = (name: string) => name.replace(OWN_TOOL_PREFIX, "")

// FIXME: Codex wraps every command in a login shell, such as /bin/zsh -lc '<command>'
const SHELL_WRAPPER = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c '((?:[^']|'\\'')*)'$/s

export const unwrapShell = (command: string) => {
  const inner = SHELL_WRAPPER.exec(command)?.[1]
  return inner === undefined ? command : inner.replaceAll(`'\\''`, "'")
}
