import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { makeActiveWorkspace } from "../../services/workspace.ts"
import * as McpTool from "./tool.ts"

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

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]

const fenced = (language: string, body: string) =>
  body.trim() === "" ? "_(none)_" : `\`\`\`${language}\n${body.trimEnd()}\n\`\`\``

const truncate = (report: string) =>
  report.length <= MAX_REPORT_CHARS
    ? report
    : `${report.slice(0, MAX_REPORT_CHARS)}\n\n> Truncated: the report was ${report.length} characters, only the first ${MAX_REPORT_CHARS} are shown. Run \`git diff\` in the workspace for the rest.`

interface ReviewTarget {
  readonly cwd: string
  readonly baseRef: string | null
}

const reviewChanges = ({ cwd, baseRef }: ReviewTarget) =>
  Effect.gen(function* () {
    const [status, headDiff] = yield* Effect.all(
      [git(cwd, ["status", "--porcelain"]), git(cwd, ["diff", ...DIFF_FLAGS, "HEAD"])],
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
      const baseDiff = yield* git(cwd, ["diff", ...DIFF_FLAGS, mergeBase])
      sections.push(`## Diff against merge-base of ${baseRef} (${mergeBase.slice(0, 12)})\n${fenced("diff", baseDiff)}`)
    }
    return truncate(sections.join("\n\n"))
  })

export const ReviewTools = Toolkit.make(
  McpTool.make("review_changes", {
    description:
      "Review this thread's uncommitted and branch changes: git status plus the unified diff against HEAD and, in a worktree, against the merge-base with its base branch.",
  }),
)

export const reviewToolsLayer = ReviewTools.toLayer(
  Effect.gen(function* () {
    const activeWorkspace = yield* makeActiveWorkspace
    return ReviewTools.of({
      review_changes: () =>
        Effect.gen(function* () {
          const threadId = yield* McpTool.CallingThread
          const workspace = yield* activeWorkspace(threadId).pipe(
            Effect.catchTag("NotFoundError", () => Effect.fail({ message: `Thread ${threadId} no longer exists.` })),
          )
          return yield* reviewChanges(workspace)
        }),
    })
  }),
)
