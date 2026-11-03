import { Effect, Layer, Option, Schema } from "effect"
import { artifactUrl } from "../shared/channels.ts"
import type { ArtifactTheme } from "../shared/artifactTheme.ts"
import { withArtifactPage } from "./artifactPage.ts"
import { type ArtifactInspection, ArtifactInspector, INSPECTION_VIEWPORT } from "./services/ArtifactInspector.ts"

const MAX_ERRORS = 10
const MAX_ERROR_LENGTH = 300

const MEASURE_LAYOUT = `(() => {
  const root = document.documentElement
  const edge = root.clientWidth
  const beyond = (element) => element !== null && element.getBoundingClientRect().right > edge + 1
  const name = (element) =>
    element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") + (element.classList.length > 0 ? "." + element.classList[0] : "")
  const culprits = root.scrollWidth > edge
    ? [...document.querySelectorAll("body, body *")].filter((element) => beyond(element) && !beyond(element.parentElement))
    : []
  return { pageWidth: root.scrollWidth, pastTheEdge: [...new Set(culprits.map(name))].slice(0, 5) }
})()`

const Layout = Schema.Struct({
  pageWidth: Schema.Number,
  pastTheEdge: Schema.Array(Schema.String.check(Schema.isMaxLength(120))),
})
const decodeLayout = Schema.decodeUnknownSync(Layout)

const Location = { url: Schema.optionalKey(Schema.String), lineNumber: Schema.optionalKey(Schema.Number) }

const RemoteValue = Schema.Struct({
  value: Schema.optionalKey(Schema.Unknown),
  description: Schema.optionalKey(Schema.String),
})

const Problem = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("Runtime.exceptionThrown"),
    params: Schema.Struct({
      exceptionDetails: Schema.Struct({ text: Schema.String, exception: Schema.optionalKey(RemoteValue), ...Location }),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("Runtime.consoleAPICalled"),
    params: Schema.Struct({
      type: Schema.Literal("error"),
      args: Schema.Array(RemoteValue),
      stackTrace: Schema.optionalKey(Schema.Struct({ callFrames: Schema.Array(Schema.Struct(Location)) })),
    }),
  }),
  Schema.Struct({
    method: Schema.Literal("Log.entryAdded"),
    params: Schema.Struct({
      entry: Schema.Struct({ level: Schema.Literal("error"), text: Schema.String, ...Location }),
    }),
  }),
])
const decodeProblem = Schema.decodeUnknownOption(Problem)

const shown = (value: typeof RemoteValue.Type) =>
  value.description ?? (typeof value.value === "string" ? value.value : JSON.stringify(value.value))

const problemText = (problem: typeof Problem.Type): { message: string; url?: string; lineNumber?: number } => {
  switch (problem.method) {
    case "Runtime.exceptionThrown": {
      const details = problem.params.exceptionDetails
      const thrown = details.exception?.description?.split("\n")[0]
      return { ...details, message: thrown === undefined ? details.text : `Uncaught ${thrown}` }
    }
    case "Runtime.consoleAPICalled":
      return { ...problem.params.stackTrace?.callFrames[0], message: problem.params.args.map(shown).join(" ") }
    case "Log.entryAdded":
      return { ...problem.params.entry, message: problem.params.entry.text }
  }
}

const errorLine = (root: string, { message, url, lineNumber }: ReturnType<typeof problemText>) => {
  const path = url?.startsWith(root) === true ? url.slice(root.length).split("?")[0] : undefined
  const where = path === undefined ? "" : lineNumber === undefined ? ` (${path})` : ` (${path}:${lineNumber + 1})`
  return `${message.slice(0, MAX_ERROR_LENGTH)}${where}`
}

const inspectPage = async (id: string, entry: string, theme: ArtifactTheme | undefined) => {
  const errors = new Set<string>()
  const root = artifactUrl(id)
  const query = theme === undefined ? "" : `?theme=${encodeURIComponent(JSON.stringify(theme))}`
  return withArtifactPage<ArtifactInspection>(
    {
      url: `${artifactUrl(id, entry)}${query}`,
      size: INSPECTION_VIEWPORT,
      onProblem: (message) => {
        const problem = decodeProblem(message)
        if (Option.isSome(problem) && errors.size < MAX_ERRORS) errors.add(errorLine(root, problemText(problem.value)))
      },
    },
    async (page) => {
      const layout = decodeLayout(await page.executeJavaScriptInIsolatedWorld(1, [{ code: MEASURE_LAYOUT }]))
      const image = await page.capturePage()
      return {
        errors: [...errors],
        pageWidth: layout.pageWidth,
        pastTheEdge: layout.pastTheEdge,
        screenshot: { data: image.toJPEG(75), mimeType: "image/jpeg" },
      }
    },
  )
}

export const electronArtifactInspector = Layer.sync(ArtifactInspector, () => {
  let theme: ArtifactTheme | undefined
  return ArtifactInspector.of({
    setTheme: (next) =>
      Effect.sync(() => {
        theme = next
      }),
    inspect: (id, entry) =>
      Effect.tryPromise(() => inspectPage(id, entry, theme)).pipe(
        Effect.catch((cause) => Effect.as(Effect.logWarning("could not inspect artifact", id, cause), null)),
      ),
  })
})
