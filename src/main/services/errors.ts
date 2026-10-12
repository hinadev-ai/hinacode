import { Schema } from "effect"

export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Database operation failed: ${this.operation}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entity: Schema.Literals(["project", "thread", "worktree", "automation", "terminal"]),
  id: Schema.String,
}) {
  override get message(): string {
    return `No ${this.entity} with id ${this.id}`
  }
}

export class ProjectPathTakenError extends Schema.TaggedError<ProjectPathTakenError>()("ProjectPathTakenError", {
  rootPath: Schema.String,
}) {
  override get message(): string {
    return `A project already uses ${this.rootPath}`
  }
}

export class ProjectRootInvalidError extends Schema.TaggedError<ProjectRootInvalidError>()("ProjectRootInvalidError", {
  rootPath: Schema.String,
}) {
  override get message(): string {
    return `${this.rootPath} is not a directory`
  }
}

/** The renderer asked to read a checkout that is neither a project root nor a live worktree. */
export class UnknownRootError extends Schema.TaggedError<UnknownRootError>()("UnknownRootError", {
  root: Schema.String,
}) {
  override get message(): string {
    return `${this.root} is not a project or worktree kkcode knows`
  }
}

/** A thread asked for a branch whose checkout another thread already owns. */
export class PullRequestElsewhereError extends Schema.TaggedError<PullRequestElsewhereError>()(
  "PullRequestElsewhereError",
  { url: Schema.String, repository: Schema.String },
) {
  override get message(): string {
    return `${this.url} is not a pull request of this project's repository, ${this.repository}`
  }
}

export class WorktreeTakenError extends Schema.TaggedError<WorktreeTakenError>()("WorktreeTakenError", {
  branch: Schema.String,
  path: Schema.String,
}) {
  override get message(): string {
    return `Branch ${this.branch} already has a worktree at ${this.path}`
  }
}

/** The agent and workspace of a thread are fixed once it has a message. */
export class ThreadStartedError extends Schema.TaggedError<ThreadStartedError>()("ThreadStartedError", {
  id: Schema.String,
}) {
  override get message(): string {
    return "This thread has already started. Start a new thread to change its agent or workspace."
  }
}

const busyReasons = {
  setup: "its setup script is still running",
  turn: "a thread is still running in it",
  shared: "another thread still uses it",
} as const

/** Removing the worktree now would delete files something is still working on. */
export class WorktreeBusyError extends Schema.TaggedError<WorktreeBusyError>()("WorktreeBusyError", {
  path: Schema.String,
  reason: Schema.Literals(["setup", "turn", "shared"]),
}) {
  override get message(): string {
    return `Cannot remove ${this.path}: ${busyReasons[this.reason]}`
  }
}

/** Wraps SQL and row-decoding failures so they share one fixed, secret-free message. */
export const persistence =
  (operation: string) =>
  (cause: unknown): PersistenceError =>
    new PersistenceError({ operation, cause })
