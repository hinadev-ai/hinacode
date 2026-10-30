const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export const parseEnvLines = (
  text: string,
): { readonly env: Record<string, string> } | { readonly invalidLine: number } => {
  const env: Record<string, string> = {}
  const lines = text.split("\n")
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const equals = trimmed.indexOf("=")
    const name = trimmed.slice(0, equals)
    if (equals < 0 || !NAME.test(name)) return { invalidLine: index + 1 }
    env[name] = trimmed.slice(equals + 1)
  }
  return { env }
}

export const formatEnvLines = (env: Readonly<Record<string, string>>) =>
  Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")
