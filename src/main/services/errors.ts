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
  entity: Schema.Literals(["project", "thread", "worktree"]),
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

/** Wraps SQL and row-decoding failures so they share one fixed, secret-free message. */
export const persistence =
  (operation: string) =>
  (cause: unknown): PersistenceError =>
    new PersistenceError({ operation, cause })
