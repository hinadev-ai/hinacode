import type { Issue } from "@linear/sdk"
import { Effect, Schema } from "effect"

export class LinearRequestError extends Schema.TaggedError<LinearRequestError>()("LinearRequestError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Linear request failed: ${this.reason}`
  }
}

const request = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LinearRequestError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  })

const fail = (reason: string) => Effect.fail(new LinearRequestError({ reason }))

const issueSummary = async (issue: Issue) => {
  const [state, assignee] = await Promise.all([issue.state, issue.assignee])
  return [
    `# ${issue.identifier}: ${issue.title}`,
    `- State: ${state?.name ?? "unknown"}`,
    `- Assignee: ${assignee?.displayName ?? "unassigned"}`,
    `- Priority: ${issue.priorityLabel}`,
    `- URL: ${issue.url}`,
    "",
    issue.description ?? "_(no description)_",
  ].join("\n")
}

export type Linear = Effect.Success<ReturnType<typeof makeLinear>>

/**
 * Linear operations exposed as MCP tools. Each returns markdown for the agent.
 * The SDK is loaded on the first call: it costs ~30 MB of main-process memory that most sessions never need.
 */
export const makeLinear = (apiKey: string) =>
  Effect.map(
    Effect.promise(() => import("@linear/sdk")),
    ({ LinearClient }) => makeTools(new LinearClient({ apiKey })),
  )

const makeTools = (client: InstanceType<typeof import("@linear/sdk").LinearClient>) => {
  const getIssue = (key: string) => request(() => client.issue(key))

  return {
    getIssue: (key: string) => Effect.flatMap(getIssue(key), (issue) => request(() => issueSummary(issue))),

    searchIssues: (query: string, limit: number) =>
      request(() => client.searchIssues(query, { first: limit })).pipe(
        Effect.map(({ nodes }) =>
          nodes.length === 0
            ? `No issues match "${query}".`
            : nodes.map((issue) => `- ${issue.identifier}: ${issue.title} (${issue.url})`).join("\n"),
        ),
      ),

    createComment: (key: string, body: string) =>
      Effect.gen(function* () {
        const issue = yield* getIssue(key)
        const payload = yield* request(() => client.createComment({ issueId: issue.id, body }))
        const comment = yield* request(async () => payload.comment)
        return `Commented on ${issue.identifier}${comment ? `: ${comment.url}` : "."}`
      }),

    updateIssueState: (key: string, stateName: string) =>
      Effect.gen(function* () {
        const issue = yield* getIssue(key)
        const team = yield* request(async () => issue.team)
        if (!team) return yield* fail(`${issue.identifier} has no team`)
        const { nodes: states } = yield* request(() => team.states())
        const state = states.find((candidate) => candidate.name.toLowerCase() === stateName.toLowerCase())
        if (!state) {
          return yield* fail(
            `team ${team.key} has no state named "${stateName}". Available: ${states.map((s) => s.name).join(", ")}`,
          )
        }
        yield* request(() => client.updateIssue(issue.id, { stateId: state.id }))
        return `${issue.identifier} moved to ${state.name}.`
      }),
  }
}
