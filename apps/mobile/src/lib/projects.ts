import type { Project, Thread } from "@shared/domain.ts"

/** The last folder of `path`, ignoring trailing slashes: `~/code/app/` is `app`. */
export const baseName = (path: string) => path.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? ""

const parentOf = (path: string) =>
  path
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/[\\/][^\\/]*$/, "")

/** Where a clone lands unless the developer picks another folder: next to the newest project, else `~/code`. */
export function defaultCloneFolder(projects: readonly Project[], repositoryName: string) {
  const newest = projects.reduce<Project | null>(
    (latest, project) => (latest === null || project.createdAt > latest.createdAt ? project : latest),
    null,
  )
  const parent = newest === null ? "~/code" : parentOf(newest.rootPath)
  return `${parent}/${repositoryName}`
}

/** Projects with the latest activity first: their newest thread, else when the project was added. */
export function projectsByActivity(projects: readonly Project[], threads: readonly Thread[]) {
  const latest = new Map<string, string>()
  for (const thread of threads) {
    const current = latest.get(thread.projectId)
    if (current === undefined || thread.updatedAt > current) latest.set(thread.projectId, thread.updatedAt)
  }
  const activity = (project: Project) => latest.get(project.id) ?? project.createdAt
  return [...projects].sort((a, b) => activity(b).localeCompare(activity(a)))
}

/**
 * Folds projects into groups of one repository, keeping their order: a project joins the earlier group with its
 * `repository` unless that group already has a project on its server, so two clones on one machine stay apart.
 */
export function groupByRepository(projects: readonly Project[]) {
  const groups: Project[][] = []
  for (const project of projects) {
    const group =
      project.repository === undefined
        ? undefined
        : groups.find(
            (candidate) =>
              candidate[0]!.repository === project.repository &&
              !candidate.some((member) => member.environmentId === project.environmentId),
          )
    if (group === undefined) groups.push([project])
    else group.push(project)
  }
  return groups
}
