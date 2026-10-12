import { Schema } from "effect"

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/

export const GitHubRepository = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(OWNER)),
  name: Schema.String.check(Schema.isPattern(NAME)),
})
export type GitHubRepository = typeof GitHubRepository.Type

/** A pasted `git clone <url>` or `gh repo clone <repo>` command: only its argument matters. */
const CLONE_COMMAND = /^(?:git\s+clone|gh\s+repo\s+clone)\s+/
const URL_FORMS = [
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/.*)?$/,
  /^git@github\.com:([^/]+)\/([^/]+)$/,
  /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  /^([^/]+)\/([^/]+)$/,
]

/**
 * The GitHub repository `input` names, as `owner/repo`, a github.com URL (https, ssh, or a link into
 * the repository), or a pasted clone command. Null for local paths and anything else.
 */
export function parseGitHubRepository(input: string): GitHubRepository | null {
  const text = input.trim().replace(CLONE_COMMAND, "")
  for (const form of URL_FORMS) {
    const match = form.exec(text)
    if (!match) continue
    const owner = match[1] ?? ""
    const name = (match[2] ?? "").replace(/\.git$/, "")
    return OWNER.test(owner) && NAME.test(name) ? { owner, name } : null
  }
  return null
}
