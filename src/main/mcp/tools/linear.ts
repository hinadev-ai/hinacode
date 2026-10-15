import type { Issue } from "@linear/sdk"
import { Effect, Option, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { Secrets } from "../../services/Secrets.ts"
import * as McpTool from "./tool.ts"

export const LINEAR_API_KEY_SECRET = "linear.apiKey"

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

type Linear = Effect.Success<ReturnType<typeof makeLinear>>

/**
 * Linear operations behind the tools. Each returns markdown for the agent.
 * The SDK is loaded on the first call: it costs ~30 MB of main-process memory that most sessions never need.
 */
const makeLinear = (apiKey: string) =>
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

const IssueKey = Schema.String.annotate({ description: "Linear issue identifier, for example ENG-123" })

export const LinearTools = Toolkit.make(
  McpTool.make("linear_get_issue", {
    description: "Read a Linear issue: title, state, assignee, priority, URL and description.",
    parameters: Schema.Struct({ key: IssueKey }),
  }),
  McpTool.make("linear_search_issues", {
    description: "Full-text search Linear issues. Returns identifier, title and URL per match.",
    parameters: Schema.Struct({
      query: Schema.String,
      limit: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
          description: "Maximum results, 1-50. Defaults to 10.",
        }),
      ),
    }),
  }),
  McpTool.make("linear_create_comment", {
    description: "Post a markdown comment on a Linear issue.",
    parameters: Schema.Struct({ key: IssueKey, body: Schema.String.annotate({ description: "Markdown body" }) }),
  }),
  McpTool.make("linear_update_issue_state", {
    description: "Move a Linear issue to a workflow state of its team, matched by name (case-insensitive).",
    parameters: Schema.Struct({
      key: IssueKey,
      stateName: Schema.String.annotate({ description: "Workflow state name, for example In Review" }),
    }),
  }),
)

export const linearToolsLayer = LinearTools.toLayer(
  Effect.gen(function* () {
    const secrets = yield* Secrets
    const withLinear = <A>(use: (linear: Linear) => Effect.Effect<A, LinearRequestError>) =>
      Effect.flatMap(
        secrets.get(LINEAR_API_KEY_SECRET),
        Option.match({
          onNone: () =>
            Effect.fail({
              message:
                "No Linear API key is configured. Ask the user to add one in KKCode Settings > Integrations, then retry.",
            }),
          onSome: (apiKey) => Effect.flatMap(makeLinear(apiKey), use),
        }),
      )
    return LinearTools.of({
      linear_get_issue: ({ key }) => withLinear((linear) => linear.getIssue(key)),
      linear_search_issues: ({ query, limit }) => withLinear((linear) => linear.searchIssues(query, limit ?? 10)),
      linear_create_comment: ({ key, body }) => withLinear((linear) => linear.createComment(key, body)),
      linear_update_issue_state: ({ key, stateName }) =>
        withLinear((linear) => linear.updateIssueState(key, stateName)),
    })
  }),
)
