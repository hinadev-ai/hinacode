import { parseGitHubRepository } from "../../shared/github.ts"

/** The name a new project gets from what was typed as its source: a repository's name, else the folder's. */
export const suggestProjectName = (source: string) =>
  parseGitHubRepository(source)?.name ?? source.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? ""
