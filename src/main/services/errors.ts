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
  entity: Schema.Literals(["project", "thread", "worktree", "automation", "terminal", "account"]),
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

export class ProjectFolderNotEmptyError extends Schema.TaggedError<ProjectFolderNotEmptyError>()(
  "ProjectFolderNotEmptyError",
  { rootPath: Schema.String },
) {
  override get message(): string {
    return `${this.rootPath} already holds other files`
  }
}

/** The renderer asked to read a checkout that is neither a project root nor a live worktree. */
export class UnknownRootError extends Schema.TaggedError<UnknownRootError>()("UnknownRootError", {
  root: Schema.String,
}) {
  override get message(): string {
    return `${this.root} is not a project or worktree HinaCode knows`
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

/** The agent and workspace of a thread are fixed once it has a message, its account once it has a session. */
export class ThreadStartedError extends Schema.TaggedError<ThreadStartedError>()("ThreadStartedError", {
  id: Schema.String,
}) {
  override get message(): string {
    return "This thread has already started. Start a new thread to change its agent, account or workspace."
  }
}

/** Switching the project root's branch would pull the files out from under another thread's turn. */
export class RootBusyError extends Schema.TaggedError<RootBusyError>()("RootBusyError", {
  path: Schema.String,
}) {
  override get message(): string {
    return `Cannot switch branches in ${this.path}: another thread is still running in it`
  }
}

/** Removing the account would leave threads with transcripts nobody can resume. */
export class AccountInUseError extends Schema.TaggedError<AccountInUseError>()("AccountInUseError", {
  id: Schema.String,
  threads: Schema.Number,
}) {
  override get message(): string {
    return `${this.threads} ${this.threads === 1 ? "thread uses" : "threads use"} this account. Delete them first.`
  }
}

/** A turn or approval is in flight, and archiving would hide it from the active sidebar. */
export class ThreadBusyError extends Schema.TaggedError<ThreadBusyError>()("ThreadBusyError", {
  id: Schema.String,
}) {
  override get message(): string {
    return "This thread is still running. Stop it or wait for it to finish before archiving."
  }
}

const busyReasons = {
  turn: "a thread is still running in it",
  shared: "another thread still uses it",
} as const

/** Removing the worktree now would delete files something is still working on. */
export class WorktreeBusyError extends Schema.TaggedError<WorktreeBusyError>()("WorktreeBusyError", {
  path: Schema.String,
  reason: Schema.Literals(["turn", "shared"]),
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
