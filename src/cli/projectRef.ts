import { resolve, sep } from "node:path"
import { Result } from "effect"
import type { Project, Worktree } from "../shared/domain.ts"
import { type CliFailure, usageError } from "./exit.ts"

export const isInside = (dir: string, root: string) =>
  dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep)

const longestFirst = <A>(items: ReadonlyArray<A>, path: (item: A) => string) =>
  items.toSorted((a, b) => path(b).length - path(a).length)

export const resolveProject = (
  raw: string,
  projects: ReadonlyArray<Project>,
  worktrees: ReadonlyArray<Worktree>,
  cwd: string,
): Result.Result<Project, CliFailure> => {
  const byId = projects.find((project) => project.id === raw)
  if (byId !== undefined) return Result.succeed(byId)
  const dir = resolve(cwd, raw)
  const projectId =
    longestFirst(projects, (project) => project.rootPath).find((project) => isInside(dir, project.rootPath))?.id ??
    longestFirst(worktrees, (worktree) => worktree.path).find((worktree) => isInside(dir, worktree.path))?.projectId
  const project = projects.find((candidate) => candidate.id === projectId)
  return project === undefined ? Result.fail(usageError(`no project contains ${dir}`)) : Result.succeed(project)
}
