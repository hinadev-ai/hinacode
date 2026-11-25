import { randomUUID } from "node:crypto"
import type { LinearClient } from "@linear/sdk"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { LinearIssue } from "../../shared/domain.ts"
import type { PersistenceError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

export const LINEAR_API_KEY_SECRET = "linear.apiKey"
export const LINEAR_WEBHOOK_SECRET = "linear.webhookSecret"
export const DEMO_VIEWER_ID = "demo-viewer"

export class LinearRequestError extends Schema.TaggedError<LinearRequestError>()("LinearRequestError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Linear request failed: ${this.reason}`
  }
}

export class LinearKeyMissing extends Schema.TaggedError<LinearKeyMissing>()("LinearKeyMissing", {}) {
  override get message(): string {
    return "Linear has no API key on this machine."
  }
}

export const linearRequest = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LinearRequestError({ reason: cause instanceof Error ? cause.message : String(cause) }),
  })

export class Linear extends Context.Service<
  Linear,
  {
    // FIXME: the Linear SDK costs ~30 MB of main-process memory, so `client` loads it on first use
    readonly client: Effect.Effect<Option.Option<LinearClient>, LinearRequestError | PersistenceError>
    readonly assignedIssues: Effect.Effect<ReadonlyArray<LinearIssue>, LinearRequestError | PersistenceError>
    readonly viewerId: Effect.Effect<Option.Option<string>, LinearRequestError | PersistenceError>
    readonly comment: (
      issueId: string,
      body: string,
    ) => Effect.Effect<{ readonly id: string }, LinearKeyMissing | LinearRequestError | PersistenceError>
    readonly wroteComment: (id: string) => Effect.Effect<boolean>
  }
>()("hinacode/Linear") {}

const ASSIGNED_ISSUES_LIMIT = 50

// FIXME: the SDK's models fetch each issue's state with a request of its own
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

const clientFor = (apiKey: string) =>
  linearRequest(() => import("@linear/sdk")).pipe(Effect.map(({ LinearClient }) => new LinearClient({ apiKey })))

const make = Effect.gen(function* () {
  const secrets = yield* Secrets

  const client = Effect.flatMap(
    secrets.get(LINEAR_API_KEY_SECRET),
    Option.match({
      onNone: () => Effect.succeedNone,
      onSome: (apiKey) => Effect.map(clientFor(apiKey), Option.some),
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

  let viewer: { readonly apiKey: string; readonly id: Option.Option<string> } | undefined

  const viewerOf = (apiKey: string) =>
    viewer?.apiKey === apiKey
      ? Effect.succeed(viewer.id)
      : linearRequest(() => import("@linear/sdk")).pipe(
          Effect.flatMap(({ LinearClient, AuthenticationLinearError }) =>
            linearRequest(() =>
              new LinearClient({ apiKey }).viewer.then(
                ({ id }) => Option.some(id),
                (cause: unknown) => {
                  if (cause instanceof AuthenticationLinearError) return Option.none<string>()
                  throw cause
                },
              ),
            ),
          ),
          Effect.tap((id) => Effect.sync(() => (viewer = { apiKey, id }))),
        )

  const viewerId = Effect.flatMap(
    secrets.get(LINEAR_API_KEY_SECRET),
    Option.match({ onNone: () => Effect.succeedNone, onSome: viewerOf }),
  )

  const written = new Set<string>()

  const comment = (issueId: string, body: string) =>
    Effect.gen(function* () {
      const linear = yield* client
      if (Option.isNone(linear)) return yield* new LinearKeyMissing()
      const id = randomUUID()
      written.add(id)
      const { success } = yield* linearRequest(() => linear.value.createComment({ id, issueId, body }))
      if (!success) return yield* new LinearRequestError({ reason: "Linear did not create the comment" })
      return { id }
    })

  return Linear.of({
    client,
    assignedIssues,
    viewerId,
    comment,
    wroteComment: (id) => Effect.sync(() => written.has(id)),
  })
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

export const mockLayer = Layer.sync(Linear, () => {
  const written = new Set<string>()
  return Linear.of({
    client: Effect.succeedNone,
    assignedIssues: Effect.sync(demoIssues),
    viewerId: Effect.succeedSome(DEMO_VIEWER_ID),
    comment: () =>
      Effect.sync(() => {
        const id = randomUUID()
        written.add(id)
        return { id }
      }),
    wroteComment: (id) => Effect.sync(() => written.has(id)),
  })
})
