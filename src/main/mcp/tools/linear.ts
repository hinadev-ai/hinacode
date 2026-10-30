import type { Issue, LinearClient, LinearDocument } from "@linear/sdk"
import { Effect, Option, Schema } from "effect"
import { Toolkit } from "effect/ai"
import { Linear, linearRequest as request, LinearRequestError } from "../../services/Linear.ts"
import * as McpTool from "./tool.ts"

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

const parseIssueKeys = (input: string) => [...new Set(input.split(/[\s,]+/).filter(Boolean))]

interface IssueSearch {
  readonly query?: string
  readonly assignee?: string
  readonly state?: string
  readonly limit: number
}

const assigneeFilter = (assignee: string): LinearDocument.IssueFilter["assignee"] =>
  assignee.toLowerCase() === "me"
    ? { isMe: { eq: true } }
    : {
        or: [
          { displayName: { eqIgnoreCase: assignee } },
          { name: { eqIgnoreCase: assignee } },
          { email: { eqIgnoreCase: assignee } },
        ],
      }

const issueFilter = ({ assignee, state }: IssueSearch): LinearDocument.IssueFilter => ({
  ...(assignee && { assignee: assigneeFilter(assignee) }),
  ...(state && { state: { name: { eqIgnoreCase: state } } }),
})

type IssueOperations = ReturnType<typeof makeTools>

const makeTools = (client: LinearClient) => {
  const getIssue = (key: string) => request(() => client.issue(key))

  return {
    getIssues: (input: string) => {
      const keys = parseIssueKeys(input)
      if (keys.length === 0) return fail("no issue key given")
      return Effect.forEach(
        keys,
        (key) =>
          getIssue(key).pipe(
            Effect.flatMap((issue) => request(() => issueSummary(issue))),
            Effect.catch((error) => Effect.succeed(`# ${key}\n\n${error.message}`)),
          ),
        { concurrency: 5 },
      ).pipe(Effect.map((summaries) => summaries.join("\n\n---\n\n")))
    },

    searchIssues: (search: IssueSearch) => {
      const variables = { filter: issueFilter(search), first: search.limit }
      return request(
        async () =>
          (search.query ? await client.searchIssues(search.query, variables) : await client.issues(variables)).nodes,
      ).pipe(
        Effect.map((nodes) =>
          nodes.length === 0
            ? "No issues match."
            : nodes.map((issue) => `- ${issue.identifier}: ${issue.title} (${issue.url})`).join("\n"),
        ),
      )
    },

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
    description:
      "Read one or more Linear issues: title, state, assignee, priority, URL and description. An issue that cannot be read reports its error in place.",
    parameters: Schema.Struct({
      key: Schema.String.annotate({
        description: "One or more Linear issue identifiers separated by commas, for example ENG-123 or ENG-123,ENG-456",
      }),
    }),
  }),
  McpTool.make("linear_search_issues", {
    description:
      "Search Linear issues by text, assignee and workflow state, in any combination. Returns identifier, title and URL per match.",
    parameters: Schema.Struct({
      query: Schema.optionalKey(Schema.String.annotate({ description: "Full-text search term" })),
      assignee: Schema.optionalKey(
        Schema.String.annotate({
          description: 'Assignee display name, full name or email, or "me" for the API key owner',
        }),
      ),
      state: Schema.optionalKey(
        Schema.String.annotate({ description: "Workflow state name, case-insensitive, for example In Progress" }),
      ),
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
    const linear = yield* Linear
    const withLinear = <A>(use: (operations: IssueOperations) => Effect.Effect<A, LinearRequestError>) =>
      Effect.flatMap(
        linear.client,
        Option.match({
          onNone: () =>
            Effect.fail({
              message:
                "No Linear API key is configured. Ask the user to add one in HinaCode Settings > Integrations, then retry.",
            }),
          onSome: (client) => use(makeTools(client)),
        }),
      )
    return LinearTools.of({
      linear_get_issue: ({ key }) => withLinear((issues) => issues.getIssues(key)),
      linear_search_issues: ({ limit, ...search }) =>
        withLinear((issues) => issues.searchIssues({ ...search, limit: limit ?? 10 })),
      linear_create_comment: ({ key, body }) => withLinear((issues) => issues.createComment(key, body)),
      linear_update_issue_state: ({ key, stateName }) =>
        withLinear((issues) => issues.updateIssueState(key, stateName)),
    })
  }),
)
