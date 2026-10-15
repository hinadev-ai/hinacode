import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NodeServices } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import * as Db from "../db/client.ts"
import * as Git from "./Git.ts"
import * as GitHub from "./GitHub.ts"
import { Projects, layer } from "./Projects.ts"

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
  Layer.provide(Layer.mergeAll(Git.layer, GitHub.layer, Db.layer(":memory:"))),
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
})

describe("Projects.clone", () => {
  it.live("refuses a folder that already holds other files, before cloning", () =>
    Effect.gen(function* () {
      const rootPath = repoWith({ "README.md": "mine" })
      const error = yield* provided(
        Projects.use((projects) =>
          projects.clone({
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
})
