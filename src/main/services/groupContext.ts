import { join } from "node:path"
import { Effect, FileSystem, Option } from "effect"
import type { Project, SidebarGroup, SidebarGroups } from "../../shared/domain.ts"
import { ClientSettings } from "./ClientSettings.ts"
import { Projects } from "./Projects.ts"

export interface GroupSkill {
  readonly name: string
  readonly description: string
  readonly path: string
}

export interface GroupMember {
  readonly id: string
  readonly name: string
  readonly rootPath: string
  readonly repository: string | null
}

export interface GroupContext {
  readonly name: string
  readonly instructions: string
  readonly skills: ReadonlyArray<GroupSkill>
  readonly members: ReadonlyArray<GroupMember>
}

export const projectGroup = (
  project: Pick<Project, "id" | "kind" | "repository">,
  { groups, groupOf }: SidebarGroups,
): SidebarGroup | null => {
  const groupId =
    project.kind === "group"
      ? project.id
      : ((project.repository === undefined ? undefined : groupOf[project.repository]) ?? groupOf[project.id])
  return groups.find((group) => group.id === groupId) ?? null
}

export const groupMembers = (
  group: Pick<Project, "id" | "kind">,
  projects: ReadonlyArray<Project>,
  sidebarGroups: SidebarGroups,
): ReadonlyArray<GroupMember> =>
  group.kind !== "group"
    ? []
    : projects
        .filter(
          (project) =>
            project.kind !== "group" &&
            project.kind !== "chats" &&
            projectGroup(project, sidebarGroups)?.id === group.id,
        )
        .map(({ id, name, rootPath, repository }) => ({ id, name, rootPath, repository: repository ?? null }))

export const reachableProjects = (projectId: string) =>
  Effect.gen(function* () {
    const listed = yield* (yield* Projects).listWithRepositories
    const project = listed.find((candidate) => candidate.id === projectId)
    if (project?.kind !== "group") return [projectId]
    const { sidebarGroups } = yield* (yield* ClientSettings).get
    return [projectId, ...groupMembers(project, listed, sidebarGroups).map((member) => member.id)]
  })

const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2")

const frontmatter = (text: string) => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ""
  const fields = new Map<string, string>()
  for (const line of block.split(/\r?\n/)) {
    const field = /^(name|description):\s*(.*)$/.exec(line)
    if (field !== null) fields.set(field[1]!, unquote(field[2]!.trim()))
  }
  return fields
}

const readSkill = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fields = frontmatter(yield* fs.readFileString(path))
    const name = fields.get("name")
    if (name === undefined || name === "") return Option.none<GroupSkill>()
    return Option.some({ name, description: fields.get("description") ?? "", path })
  }).pipe(Effect.orElseSucceed(() => Option.none<GroupSkill>()))

export const readGroup = (name: string, rootPath: string, members: ReadonlyArray<GroupMember> = []) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const instructions = yield* fs.readFileString(join(rootPath, "AGENTS.md")).pipe(Effect.orElseSucceed(() => ""))
    const skillsDir = join(rootPath, "skills")
    const entries = yield* fs.readDirectory(skillsDir).pipe(Effect.orElseSucceed(() => []))
    const skills = yield* Effect.forEach(entries.toSorted(), (entry) => readSkill(join(skillsDir, entry, "SKILL.md")))
    return {
      name,
      instructions: instructions.trim(),
      skills: skills.flatMap(Option.toArray),
      members,
    } satisfies GroupContext
  })

export const groupContext = (projectId: string) =>
  Effect.gen(function* () {
    const projects = yield* Projects
    const { sidebarGroups } = yield* (yield* ClientSettings).get
    if (sidebarGroups.groups.length === 0) return null
    const listed = yield* projects.listWithRepositories
    const project = listed.find((candidate) => candidate.id === projectId)
    if (project === undefined) return null
    const group = projectGroup(project, sidebarGroups)
    const groupProject = group === null ? undefined : listed.find((candidate) => candidate.id === group.id)
    if (group === null || groupProject?.kind !== "group") return null
    return yield* readGroup(group.name, groupProject.rootPath, groupMembers(project, listed, sidebarGroups))
  })
