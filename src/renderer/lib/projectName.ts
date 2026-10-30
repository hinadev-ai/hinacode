import { parseGitHubRepository } from "../../shared/github.ts"

export const suggestProjectName = (source: string) =>
  parseGitHubRepository(source)?.name ?? source.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? ""
