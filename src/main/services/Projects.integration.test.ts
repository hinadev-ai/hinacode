import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as Db from "../db/client.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import type { PushEvent } from "../../shared/contract.ts"
import { Events } from "./Events.ts"
import { Projects, layer } from "./Projects.ts"

const noEvents = Layer.succeed(Events, { publish: () => Effect.void })

const dirs: Array<string> = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const repoWith = (files: Record<string, string | Buffer>) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kk-projects-test-")))
  dirs.push(dir)
  execFileSync("git", ["init", "-q", dir])
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

const projectsLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer.pipe(Layer.provide(noEvents)), Db.layer(":memory:"), noEvents)),
  Layer.provide(NodeServices.layer),
)

const iconOf = (rootPath: string) =>
  Projects.use((projects) =>
    projects
      .create({ name: "repo", rootPath, setupScript: null })
      .pipe(Effect.flatMap((project) => projects.icon(project.id))),
  ).pipe(Effect.provide(projectsLayer))

const withOrigin = (origin: string | null) => {
  const dir = repoWith({ "apps/web/README.md": "web" })
  if (origin !== null) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin])
  return dir
}

const listedAt = (rootPath: string) =>
  Projects.use((projects) =>
    projects.create({ name: "repo", rootPath, setupScript: null }).pipe(Effect.andThen(projects.listWithRepositories)),
  ).pipe(
    Effect.map(([project]) => project),
    Effect.provide(projectsLayer),
  )

describe("Projects.icon", () => {
  it.live("reads the project's favicon as a data URL", () =>
    Effect.gen(function* () {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'
      const icon = yield* iconOf(repoWith({ "public/favicon.svg": svg }))
      expect(icon).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
    }),
  )

  it.live("prefers the root's own favicon over one deeper in the tree", () =>
    Effect.gen(function* () {
      const icon = yield* iconOf(repoWith({ "favicon.ico": "root", "app/icon.png": "app" }))
      expect(icon).toBe(`data:image/x-icon;base64,${Buffer.from("root").toString("base64")}`)
    }),
  )

  it.live("is null without a favicon, and skips one too large to be an icon", () =>
    Effect.gen(function* () {
      expect(yield* iconOf(repoWith({ "README.md": "hi" }))).toBeNull()
      expect(yield* iconOf(repoWith({ "favicon.png": Buffer.alloc(200 * 1024) }))).toBeNull()
    }),
  )
})

describe("Projects.listWithRepositories", () => {
  it.live("names the GitHub repository origin points at, in lower case", () =>
    Effect.gen(function* () {
      expect((yield* listedAt(withOrigin("git@github.com:Acme/Web.git")))?.repository).toBe("acme/web")
      expect((yield* listedAt(withOrigin("https://github.com/acme/web.git")))?.repository).toBe("acme/web")
    }),
  )

  it.live("adds the folder when the project is rooted inside the repository", () =>
    Effect.gen(function* () {
      const root = join(withOrigin("git@github.com:Acme/Mono.git"), "apps/web")
      expect((yield* listedAt(root))?.repository).toBe("acme/mono/apps/web")
    }),
  )

  it.live("remembers each root's repository until the project is edited", () =>
    Effect.gen(function* () {
      const projects = yield* Projects
      const root = withOrigin("git@github.com:acme/old.git")
      const project = yield* projects.create({ name: "repo", rootPath: root, setupScript: null })
      const repository = Effect.map(projects.listWithRepositories, ([listed]) => listed?.repository)
      expect(yield* repository).toBe("acme/old")

      execFileSync("git", ["-C", root, "remote", "set-url", "origin", "git@github.com:acme/new.git"])
      expect(yield* repository).toBe("acme/old")

      yield* projects.update({ id: project.id, name: "renamed" })
      expect(yield* repository).toBe("acme/new")
    }).pipe(Effect.provide(projectsLayer)),
  )

  it.live("keeps a project's actions across edits that leave them out", () =>
    Effect.gen(function* () {
      const projects = yield* Projects
      const project = yield* projects.create({ name: "repo", rootPath: withOrigin(null), setupScript: null })
      expect(project.actions).toStrictEqual([])

      const actions = [
        { name: "Dev server", command: "pnpm dev" },
        { name: "Test", command: "pnpm test" },
      ]
      yield* projects.update({ id: project.id, actions })
      yield* projects.update({ id: project.id, name: "renamed" })
      expect((yield* projects.get(project.id)).actions).toStrictEqual(actions)
    }).pipe(Effect.provide(projectsLayer)),
  )

  it.live("leaves the key out without a GitHub origin", () =>
    Effect.gen(function* () {
      expect(yield* listedAt(withOrigin(null))).not.toHaveProperty("repository")
      expect(yield* listedAt(withOrigin("https://gitlab.com/acme/web.git"))).not.toHaveProperty("repository")
    }),
  )
})

const emptyDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "kk-projects-test-")))
  dirs.push(dir)
  return dir
}

const provided = <A, E>(effect: Effect.Effect<A, E, Projects>) => effect.pipe(Effect.provide(projectsLayer))

describe("Projects.create", () => {
  it.live("creates a folder that does not exist yet", () =>
    Effect.gen(function* () {
      const rootPath = join(emptyDir(), "code", "new-app")
      const project = yield* provided(
        Projects.use((projects) => projects.create({ name: "new-app", rootPath, setupScript: null })),
      )
      expect(project.rootPath).toBe(rootPath)
      expect(statSync(rootPath).isDirectory()).toBe(true)
    }),
  )

  it.live("refuses a path that is a file", () =>
    Effect.gen(function* () {
      const rootPath = join(emptyDir(), "notes.txt")
      writeFileSync(rootPath, "hi")
      const error = yield* provided(
        Projects.use((projects) => projects.create({ name: "notes", rootPath, setupScript: null })),
      ).pipe(Effect.flip)
      expect(error._tag).toBe("ProjectRootInvalidError")
    }),
  )

  it.live("sends a folder inside WSL to a cloud running in WSL", () =>
    Effect.gen(function* () {
      for (const rootPath of ["\\\\wsl.localhost\\Ubuntu\\home\\me\\app", "\\\\WSL$\\Debian\\srv\\app"]) {
        const error = yield* provided(
          Projects.use((projects) => projects.create({ name: "app", rootPath, setupScript: null })),
        ).pipe(Effect.flip)
        expect(error._tag).toBe("ProjectInWslError")
      }
    }),
  )
})

const withGitHubMock = (github: Partial<GitHub.GitHub["Service"]>, events = noEvents) =>
  layer.pipe(
    Layer.provide(Layer.mergeAll(Git.layer, Layer.mock(GitHub.GitHub, github), Db.layer(":memory:"), events)),
    Layer.provide(NodeServices.layer),
  )

const withGitHub = (createRepository: GitHub.GitHub["Service"]["createRepository"]) =>
  withGitHubMock({ createRepository })

describe("Projects.create with a new GitHub repository", () => {
  const identity = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  }
  beforeAll(() => {
    Object.assign(process.env, identity)
    return () => Object.keys(identity).forEach((key) => delete process.env[key])
  })

  it.live("starts the folder's history and publishes it with the chosen visibility", () =>
    Effect.gen(function* () {
      const rootPath = join(emptyDir(), "new-app")
      const published: Array<[string, string]> = []
      const project = yield* Projects.use((projects) =>
        projects.create({ name: "new-app", rootPath, setupScript: null, createRepository: "private" }),
      ).pipe(Effect.provide(withGitHub((cwd, visibility) => Effect.sync(() => void published.push([cwd, visibility])))))
      expect(project.rootPath).toBe(rootPath)
      expect(published).toStrictEqual([[rootPath, "private"]])
      expect(execFileSync("git", ["-C", rootPath, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim()).toBe(
        "1",
      )
    }),
  )

  it.live("keeps already staged files out of the published initial commit", () =>
    Effect.gen(function* () {
      const rootPath = repoWith({ ".env": "SECRET=1" })
      execFileSync("git", ["-C", rootPath, "add", ".env"])
      yield* Projects.use((projects) =>
        projects.create({ name: "staged", rootPath, setupScript: null, createRepository: "public" }),
      ).pipe(Effect.provide(withGitHub(() => Effect.void)))
      const git = (...args: Array<string>) =>
        execFileSync("git", ["-C", rootPath, ...args], { encoding: "utf8" }).trim()
      expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("")
      expect(git("diff", "--cached", "--name-only")).toBe(".env")
    }),
  )

  it.live("refuses a folder that already has an origin before creating anything on GitHub", () =>
    Effect.gen(function* () {
      const rootPath = withOrigin("https://github.com/octocat/elsewhere.git")
      const published: Array<string> = []
      const error = yield* Projects.use((projects) =>
        projects.create({ name: "elsewhere", rootPath, setupScript: null, createRepository: "private" }),
      ).pipe(Effect.flip, Effect.provide(withGitHub((cwd) => Effect.sync(() => void published.push(cwd)))))
      expect(error._tag).toBe("ProjectOriginTakenError")
      expect(published).toStrictEqual([])
    }),
  )

  it.live("adds no project when GitHub refuses the repository", () =>
    Effect.gen(function* () {
      const rootPath = join(emptyDir(), "taken")
      const refused = new Git.CommandError({ command: "gh", args: [], exitCode: 1, stderr: "name already exists" })
      const listed = yield* Projects.use((projects) =>
        projects
          .create({ name: "taken", rootPath, setupScript: null, createRepository: "private" })
          .pipe(Effect.flip, Effect.andThen(projects.list)),
      ).pipe(Effect.provide(withGitHub(() => Effect.fail(refused))))
      expect(listed).toStrictEqual([])
    }),
  )
})

describe("Projects.update", () => {
  it.live("normalizes a moved root the way create does", () =>
    Effect.gen(function* () {
      const projects = yield* Projects
      const project = yield* projects.create({ name: "repo", rootPath: emptyDir(), setupScript: null })
      const moved = emptyDir()

      const updated = yield* projects.update({ id: project.id, rootPath: ` ${moved}/ ` })
      expect(updated.rootPath).toBe(moved)
      expect((yield* projects.get(project.id)).rootPath).toBe(moved)
    }).pipe(Effect.provide(projectsLayer)),
  )
})

describe("Projects.clone", () => {
  it.live("keeps a folder that already holds the clone, whatever the repository name's case", () =>
    Effect.gen(function* () {
      const rootPath = withOrigin("git@github.com:octocat/hello-world.git")
      const project = yield* provided(
        Projects.use((projects) =>
          projects.clone({
            cloneId: "clone",
            repository: { owner: "octocat", name: "Hello-World" },
            rootPath,
            name: "x",
            setupScript: null,
          }),
        ),
      )
      expect(project.rootPath).toBe(rootPath)
    }),
  )

  it.live("refuses a folder that already holds other files, before cloning", () =>
    Effect.gen(function* () {
      const rootPath = repoWith({ "README.md": "mine" })
      const error = yield* provided(
        Projects.use((projects) =>
          projects.clone({
            cloneId: "clone",
            repository: { owner: "octocat", name: "Hello-World" },
            rootPath,
            name: "x",
            setupScript: null,
          }),
        ),
      ).pipe(Effect.flip)
      expect(error._tag).toBe("ProjectFolderNotEmptyError")
      expect(existsSync(join(rootPath, "README.md"))).toBe(true)
    }),
  )

  it.live("publishes progress and stops a cancelled clone without adding the project", () =>
    Effect.gen(function* () {
      const rootPath = join(emptyDir(), "Hello-World")
      const firstProgress = yield* Deferred.make<PushEvent>()
      const events = Layer.succeed(Events, { publish: (event) => Deferred.succeed(firstProgress, event) })
      const interrupted = yield* Deferred.make<void>()
      const cloneForever: GitHub.GitHub["Service"]["clone"] = (_repository, _dest, onProgress) =>
        onProgress({ phase: "Receiving objects", percent: 40 }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        )
      const [error, listed] = yield* Projects.use((projects) =>
        Effect.gen(function* () {
          const clone = yield* Effect.forkChild(
            projects.clone({
              cloneId: "c1",
              repository: { owner: "octocat", name: "Hello-World" },
              rootPath,
              name: "x",
              setupScript: null,
            }),
          )
          expect(yield* Deferred.await(firstProgress)).toStrictEqual({
            type: "project.cloneProgress",
            cloneId: "c1",
            progress: { phase: "Receiving objects", percent: 40 },
          })
          yield* projects.cancelClone("c1")
          return [yield* Effect.flip(Fiber.join(clone)), yield* projects.list] as const
        }),
      ).pipe(Effect.provide(withGitHubMock({ clone: cloneForever }, events)))
      expect(error._tag).toBe("ProjectCloneCancelledError")
      expect(yield* Deferred.isDone(interrupted)).toBe(true)
      expect(listed).toStrictEqual([])
    }),
  )

  it.live("honours a cancel that arrives while the folder is still being checked", () =>
    Effect.gen(function* () {
      const rootPath = join(emptyDir(), "Hello-World")
      const checking = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const pausedOriginCheck = Layer.mock(Git.Git, {
        run: () =>
          Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.andThen(Effect.fail(new Git.CommandError({ command: "git", args: [], exitCode: 2, stderr: "" }))),
          ),
      })
      const cloned: Array<string> = []
      const github = Layer.mock(GitHub.GitHub, {
        installed: Effect.succeed(true),
        clone: (_repository, dest) => Effect.sync(() => void cloned.push(dest)),
      })
      const [error, listed] = yield* Projects.use((projects) =>
        Effect.gen(function* () {
          const clone = yield* Effect.forkChild(
            projects.clone({
              cloneId: "c2",
              repository: { owner: "octocat", name: "Hello-World" },
              rootPath,
              name: "x",
              setupScript: null,
            }),
          )
          yield* Deferred.await(checking)
          yield* projects.cancelClone("c2")
          yield* Deferred.succeed(resume, undefined)
          return [yield* Effect.flip(Fiber.join(clone)), yield* projects.list] as const
        }),
      ).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(Layer.mergeAll(pausedOriginCheck, github, Db.layer(":memory:"), noEvents)),
            Layer.provide(NodeServices.layer),
          ),
        ),
      )
      expect(error._tag).toBe("ProjectCloneCancelledError")
      expect(cloned).toStrictEqual([])
      expect(listed).toStrictEqual([])
    }),
  )
})

describe("Projects.ensureChats", () => {
  it.live("keeps one chats project, moved to the latest folder", () =>
    Effect.gen(function* () {
      const [first, second] = [join(emptyDir(), "chats"), join(emptyDir(), "chats")]
      const listed = yield* provided(
        Projects.use((projects) =>
          projects.ensureChats(first).pipe(Effect.andThen(projects.ensureChats(second)), Effect.andThen(projects.list)),
        ),
      )
      expect(listed.map(({ kind, rootPath }) => ({ kind, rootPath }))).toStrictEqual([
        { kind: "chats", rootPath: second },
      ])
      expect(statSync(second).isDirectory()).toBe(true)
    }),
  )
})
