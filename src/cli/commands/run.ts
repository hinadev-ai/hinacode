import { resolve } from "node:path"
import { text } from "node:stream/consumers"
import { Effect, Option, Result } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ProviderId } from "../../shared/agent.ts"
import { AccessMode, type Project, toCheckoutTarget, type WorkspaceChoice } from "../../shared/domain.ts"
import type { Client } from "../client.ts"
import { usageError } from "../exit.ts"
import { awaitOutcome } from "../outcome.ts"
import { resolveProject } from "../projectRef.ts"
import { emit, succeed, withClient } from "../session.ts"

export interface RunOptions {
  readonly prompt: string
  readonly cwd: string
  readonly project: string | undefined
  readonly machine: string | undefined
  readonly provider: ProviderId | undefined
  readonly model: string | undefined
  readonly effort: string | undefined
  readonly accessMode: AccessMode | undefined
  readonly workspace: WorkspaceChoice["mode"] | undefined
  readonly from: string | undefined
  readonly attach: ReadonlyArray<string>
  readonly wait: boolean
}

const onMachine = (client: Client, here: Project, projects: ReadonlyArray<Project>, wanted: string) =>
  Effect.gen(function* () {
    const machines = yield* client.call("machines.list", undefined)
    const machine = machines.find(
      (candidate) => candidate.id === wanted || candidate.name.toLowerCase() === wanted.toLowerCase(),
    )
    if (machine === undefined) {
      return yield* usageError(`no machine named ${wanted}. Run hinacode machines to see them.`)
    }
    const machineProjects = new Set(machine.projectIds)
    if (machineProjects.has(here.id)) return here
    const twin =
      here.repository === undefined
        ? undefined
        : projects.find((project) => machineProjects.has(project.id) && project.repository === here.repository)
    if (twin === undefined) {
      return yield* usageError(`${machine.name} has no project for ${here.repository ?? here.name}.`)
    }
    return twin
  })

const chooseWorkspace = (client: Client, project: Project, options: RunOptions) =>
  Effect.gen(function* () {
    if (project.kind !== "folder") return undefined
    const mode = options.workspace ?? (yield* client.call("settings.get", undefined)).defaultWorkspaceMode
    const ref =
      options.from ??
      (yield* client.call(mode === "worktree" ? "projects.defaultBranch" : "projects.currentBranch", {
        id: project.id,
      }))
    return { mode, target: toCheckoutTarget(ref) } satisfies WorkspaceChoice
  })

export const runThread = (client: Client, options: RunOptions) =>
  Effect.gen(function* () {
    const [projects, worktrees] = yield* Effect.all([
      client.call("projects.list", undefined),
      client.call("worktrees.list", undefined),
    ])
    const resolved = resolveProject(options.project ?? options.cwd, projects, worktrees, options.cwd)
    if (Result.isFailure(resolved) && options.project === undefined) {
      return yield* usageError(`No HinaCode project contains ${options.cwd}. Add it in the app, or pass --project.`)
    }
    const here = yield* Effect.fromResult(resolved)
    const project = options.machine === undefined ? here : yield* onMachine(client, here, projects, options.machine)

    const draft = yield* client.call("threads.draft", { projectId: project.id })
    const settings = {
      ...(options.provider !== undefined && { provider: options.provider }),
      ...(options.model !== undefined && { model: options.model }),
      ...(options.effort !== undefined && { effort: options.effort }),
      ...(options.accessMode !== undefined && { accessMode: options.accessMode }),
    }
    const thread =
      Object.keys(settings).length === 0 ? draft : yield* client.call("threads.update", { id: draft.id, ...settings })
    const attachments = yield* Effect.forEach(options.attach, (path) =>
      client.call("attachments.stage", { threadId: thread.id, source: { path: resolve(options.cwd, path) } }),
    )
    const workspace = yield* chooseWorkspace(client, project, options)

    const events = options.wait ? yield* client.subscribe : undefined
    if (events !== undefined) yield* client.watch([thread.id])
    yield* client.call("threads.send", { threadId: thread.id, prompt: options.prompt, attachments, workspace })
    if (events !== undefined) return yield* awaitOutcome(events, thread)
    return succeed({ threadId: thread.id, title: thread.title, projectId: project.id })
  })

const readPrompt = (argument: string | undefined) =>
  Effect.gen(function* () {
    const piped = process.stdin.isTTY ? "" : (yield* Effect.promise(() => text(process.stdin))).trim()
    const prompt = [argument?.trim() ?? "", piped].filter((part) => part !== "").join("\n\n")
    if (prompt === "") return yield* usageError("pass a prompt, or pipe one on stdin")
    return prompt
  })

const optionalString = (name: string, metavar: string, description: string) =>
  Flag.String(name).pipe(Flag.withMetavar(metavar), Flag.withDescription(description), Flag.optional)

const flag = (name: string, description: string) =>
  Flag.Boolean(name).pipe(Flag.withDefault(false), Flag.withDescription(description))

export const run = Command.make(
  "run",
  {
    prompt: Argument.String("prompt").pipe(
      Argument.withDescription("What the agent should do. Piped stdin is added after it."),
      Argument.optional,
    ),
    project: optionalString("project", "id|path", "The project to run in. Defaults to the one containing this folder."),
    machine: optionalString("machine", "name", "Run on this machine, in its project for the same GitHub repository."),
    provider: Flag.Literals("provider", ProviderId.literals).pipe(
      Flag.withDescription("The agent, such as claude or codex."),
      Flag.optional,
    ),
    model: optionalString("model", "id", "The model."),
    effort: optionalString("effort", "level", "The reasoning effort."),
    access: Flag.Literals("access", AccessMode.literals).pipe(
      Flag.withDescription("What the agent may do without asking."),
      Flag.optional,
    ),
    worktree: flag("worktree", "Run in a new worktree."),
    here: flag("here", "Run in the project's checkout itself."),
    from: optionalString(
      "from",
      "ref|#pr",
      "The branch or pull request to start from. Defaults to the default branch for a worktree, and the current branch here.",
    ),
    attach: Flag.String("attach").pipe(
      Flag.withMetavar("file"),
      Flag.withDescription("Attach a file. Repeat it for more."),
      Flag.atLeast(0),
    ),
    wait: flag(
      "wait",
      "Block until the turn ends or asks for something, then print the outcome. Exit 0 done, 1 failed, 2 needs a human, 3 limited.",
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      if (flags.worktree && flags.here) return yield* usageError("pass --worktree or --here, not both")
      const prompt = yield* readPrompt(Option.getOrUndefined(flags.prompt))
      return yield* emit(
        withClient((client) =>
          runThread(client, {
            prompt,
            cwd: process.cwd(),
            project: Option.getOrUndefined(flags.project),
            machine: Option.getOrUndefined(flags.machine),
            provider: Option.getOrUndefined(flags.provider),
            model: Option.getOrUndefined(flags.model),
            effort: Option.getOrUndefined(flags.effort),
            accessMode: Option.getOrUndefined(flags.access),
            workspace: flags.worktree ? "worktree" : flags.here ? "local" : undefined,
            from: Option.getOrUndefined(flags.from),
            attach: flags.attach,
            wait: flags.wait,
          }),
        ),
      )
    }),
).pipe(Command.withDescription("Start a thread in the project you stand in, and print its id."))
