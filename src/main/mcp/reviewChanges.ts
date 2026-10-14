import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { PATCH_FLAGS } from "../services/Git.ts"

const execFileAsync = promisify(execFile)

const MAX_REPORT_CHARS = 60_000

export class GitCommandError extends Schema.TaggedError<GitCommandError>()("GitCommandError", {
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  stderr: Schema.String,
}) {
  override get message(): string {
    return `git ${this.args.join(" ")} failed in ${this.cwd}: ${this.stderr.trim()}`
  }
}

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => (await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout,
    catch: (cause) =>
      new GitCommandError({
        args,
        cwd,
        stderr: cause instanceof Error && "stderr" in cause ? String(cause.stderr) : String(cause),
      }),
  })

const fenced = (language: string, body: string) =>
  body.trim() === "" ? "_(none)_" : `\`\`\`${language}\n${body.trimEnd()}\n\`\`\``

const truncate = (report: string) =>
  report.length <= MAX_REPORT_CHARS
    ? report
    : `${report.slice(0, MAX_REPORT_CHARS)}\n\n> Truncated: the report was ${report.length} characters, only the first ${MAX_REPORT_CHARS} are shown. Run \`git diff\` in the workspace for the rest.`

export interface ReviewTarget {
  readonly cwd: string
  /** Set when the thread runs in a worktree: also diff against the merge-base with this ref. */
  readonly baseRef: string | null
}

/** Markdown report of a workspace's changes: `git status`, the diff against HEAD and, for worktrees, against the base. */
export const reviewChanges = ({ cwd, baseRef }: ReviewTarget) =>
  Effect.gen(function* () {
    const [status, headDiff] = yield* Effect.all(
      [git(cwd, ["status", "--porcelain"]), git(cwd, ["diff", ...PATCH_FLAGS, "HEAD"])],
      {
        concurrency: "unbounded",
      },
    )
    const sections = [
      `# Changes in ${cwd}`,
      `## Files (git status --porcelain)\n${fenced("", status)}`,
      `## Diff against HEAD\n${fenced("diff", headDiff)}`,
    ]
    if (baseRef !== null) {
      const mergeBase = (yield* git(cwd, ["merge-base", baseRef, "HEAD"])).trim()
      const baseDiff = yield* git(cwd, ["diff", ...PATCH_FLAGS, mergeBase])
      sections.push(`## Diff against merge-base of ${baseRef} (${mergeBase.slice(0, 12)})\n${fenced("diff", baseDiff)}`)
    }
    return truncate(sections.join("\n\n"))
  })
