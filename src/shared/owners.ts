import type { PushEvent, RpcMethod } from "./contract.ts"
import type { Entity } from "./routes.ts"

/**
 * Which cloud owns an id. Only cloud ids are recorded: an id nobody claimed belongs to this desktop. Ids are UUIDs
 * except roots, which are paths, so two machines with the same checkout path both claim it and the last one wins.
 */
const key = (entity: Entity, id: string) => `${entity}:${id}`

export const makeOwners = () => {
  const index = new Map<string, string>()
  return {
    teach: (environmentId: string, entity: Entity, id: string) => void index.set(key(entity, id), environmentId),
    owner: (entity: Entity, id: string): string | undefined => index.get(key(entity, id)),
    forget: (environmentId: string) => {
      for (const [entry, owner] of index) if (owner === environmentId) index.delete(entry)
    },
  }
}

export type Owners = ReturnType<typeof makeOwners>

type Teach = (entity: Entity, id: unknown) => void

const field = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined

const each = (value: unknown, learn: (item: unknown) => void) => {
  if (Array.isArray(value)) value.forEach(learn)
  else learn(value)
}

const learnProject = (teach: Teach) => (project: unknown) => {
  teach("project", field(project, "id"))
  teach("root", field(project, "rootPath"))
}
const learnWorktree = (teach: Teach) => (worktree: unknown) => {
  teach("worktree", field(worktree, "id"))
  teach("root", field(worktree, "path"))
}
const learnId = (teach: Teach, entity: Entity) => (item: unknown) => teach(entity, field(item, "id"))

/** Teaches `owners` the ids in a cloud's answer to `method`, which arrives JSON-encoded and is read loosely. */
export const learnFromAnswer = (
  owners: Owners,
  environmentId: string,
  method: RpcMethod,
  payload: unknown,
  result: unknown,
) => {
  const teach: Teach = (entity, id) => {
    if (typeof id === "string") owners.teach(environmentId, entity, id)
  }
  switch (method) {
    case "projects.list":
    case "projects.create":
    case "projects.clone":
    case "projects.update":
      return each(result, learnProject(teach))
    case "threads.list":
    case "threads.create":
    case "threads.update":
    case "threads.archive":
    case "threads.unarchive":
      return each(result, learnId(teach, "thread"))
    case "worktrees.list":
    case "worktrees.create":
      return each(result, learnWorktree(teach))
    case "terminal.open":
    case "terminal.list":
      return each(result, learnId(teach, "terminal"))
    case "automations.list":
    case "automations.create":
    case "automations.update":
      return each(result, learnId(teach, "automation"))
    case "threads.transcript":
      for (const name of ["approvals", "questions", "secretRequests"])
        each(field(result, name), learnId(teach, "request"))
      return
    case "vm.screen.open":
      return teach("stream", field(payload, "streamId"))
  }
}

/** Teaches `owners` the ids in a push a cloud sent. */
export const learnFromPush = (owners: Owners, environmentId: string, event: PushEvent) => {
  const teach = (entity: Entity, id: string | null) => {
    if (id !== null) owners.teach(environmentId, entity, id)
  }
  switch (event.type) {
    case "thread.updated":
      return teach("thread", event.thread.id)
    case "worktree.updated":
      teach("worktree", event.worktree.id)
      return teach("root", event.worktree.path)
    case "terminal.data":
    case "terminal.exited":
      return teach("terminal", event.id)
    case "automation.run":
      teach("automation", event.run.automationId)
      return teach("thread", event.run.threadId)
    case "thread.event":
      teach("thread", event.threadId)
      if (
        event.event.type === "approval_requested" ||
        event.event.type === "question_requested" ||
        event.event.type === "secret_requested"
      ) {
        teach("request", event.event.request.id)
      }
  }
}

/** Answers that carry projects, which a client stamps with the environment they came from. */
const projectAnswers: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "projects.list",
  "projects.create",
  "projects.clone",
  "projects.update",
])

const stamp = (result: unknown, environmentId: string): unknown =>
  Array.isArray(result)
    ? result.map((project) => stamp(project, environmentId))
    : typeof result === "object" && result !== null
      ? { ...result, environmentId }
      : result

/** `result` with each project in an answer to `method` marked as `environmentId`'s, for the client to show where it lives. */
export const stampProjects = (method: RpcMethod, result: unknown, environmentId: string) =>
  projectAnswers.has(method) ? stamp(result, environmentId) : result
