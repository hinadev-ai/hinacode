import type { LinearClient } from "@linear/sdk"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LinearIssue } from "../../shared/domain.ts"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

export const LINEAR_API_KEY_SECRET = "linear.apiKey"

export class LinearRequestError extends Schema.TaggedError<LinearRequestError>()("LinearRequestError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Linear request failed: ${this.reason}`
  }
}

export const linearRequest = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LinearRequestError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  })

/** This machine's Linear account, through the API key in `Secrets`. */
export class Linear extends Context.Service<
  Linear,
  {
    /**
     * A client for this machine's key, or none when it has no key. The SDK is loaded on the first call: it costs
     * ~30 MB of main-process memory that most sessions never need.
     */
    readonly client: Effect.Effect<Option.Option<LinearClient>, LinearRequestError | PersistenceError>
    /** Open issues assigned to the key's owner, most recently updated first. Empty when there is no key. */
    readonly assignedIssues: Effect.Effect<ReadonlyArray<LinearIssue>, LinearRequestError | PersistenceError>
  }
>()("hinacode/Linear") {}

const ASSIGNED_ISSUES_LIMIT = 50

// One query instead of the SDK's models, which fetch each issue's state with a request of its own.
const assignedIssuesQuery = `
  query AssignedIssues($first: Int!) {
    issues(
      first: $first
      orderBy: updatedAt
      filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }
    ) {
      nodes { id identifier title url priority updatedAt state { name type } }
    }
  }
`

const AssignedIssuesData = Schema.Struct({ issues: Schema.Struct({ nodes: Schema.Array(LinearIssue) }) })

const make = Effect.gen(function* () {
  const secrets = yield* Secrets

  const client = Effect.flatMap(
    secrets.get(LINEAR_API_KEY_SECRET),
    Option.match({
      onNone: () => Effect.succeedNone,
      onSome: (apiKey) =>
        linearRequest(() => import("@linear/sdk")).pipe(
          Effect.map(({ LinearClient }) => Option.some(new LinearClient({ apiKey }))),
        ),
    }),
  )

  const assignedIssues = Effect.flatMap(
    client,
    Option.match({
      onNone: () => Effect.succeed([]),
      onSome: (linear) =>
        linearRequest(() => linear.client.rawRequest(assignedIssuesQuery, { first: ASSIGNED_ISSUES_LIMIT })).pipe(
          Effect.flatMap(({ data }) => Schema.decodeUnknownEffect(AssignedIssuesData)(data)),
          Effect.map((data) => data.issues.nodes),
          Effect.mapError((error) =>
            error instanceof LinearRequestError ? error : new LinearRequestError({ reason: error.message }),
          ),
        ),
    }),
  )

  return Linear.of({ client, assignedIssues })
})

export const layer = Layer.effect(Linear, make)

const demoIssue = (
  identifier: string,
  title: string,
  state: LinearIssue["state"],
  priority: number,
  hoursAgo: number,
) => ({
  id: `demo-${identifier}`,
  identifier,
  title,
  url: `https://linear.app/demo/issue/${identifier.toLowerCase()}`,
  state,
  priority,
  updatedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
})

const demoIssues = () => [
  demoIssue("ENG-142", "Retry webhook deliveries after a timeout", { name: "In Progress", type: "started" }, 1, 0.5),
  demoIssue("ENG-138", "Show the merge queue position on pull requests", { name: "In Review", type: "started" }, 2, 3),
  demoIssue("ENG-151", "Paginate the automation run history", { name: "Todo", type: "unstarted" }, 2, 20),
  demoIssue("ENG-120", "Remember the last picked model per project", { name: "Todo", type: "unstarted" }, 3, 30),
  demoIssue("DES-27", "Dark mode contrast for diff gutters", { name: "Backlog", type: "backlog" }, 4, 72),
  demoIssue("ENG-163", "Explain the empty ports panel", { name: "Triage", type: "triage" }, 0, 96),
]

/** Demo tickets and no client, chosen by `HINACODE_MOCK_LINEAR`, so screenshots never show a real workspace. */
export const mockLayer = Layer.succeed(
  Linear,
  Linear.of({ client: Effect.succeedNone, assignedIssues: Effect.sync(demoIssues) }),
)
