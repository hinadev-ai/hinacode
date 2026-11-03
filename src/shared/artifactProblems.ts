import { Option, Schema } from "effect"
import { insertAtHeadStart } from "./artifactTheme.ts"

const PROBLEM_TYPE = "hinacode-artifact-problem"
const MAX_MESSAGE_LENGTH = 500
const MAX_PROBLEMS = 20

const ArtifactProblem = Schema.Struct({
  type: Schema.Literal(PROBLEM_TYPE),
  message: Schema.String,
})

const decodeProblem = Schema.decodeUnknownOption(ArtifactProblem)

export const artifactProblemMessage = (data: unknown) =>
  Option.getOrUndefined(Option.map(decodeProblem(data), (problem) => problem.message.slice(0, MAX_MESSAGE_LENGTH)))

export const addArtifactProblem = (problems: ReadonlyArray<string>, message: string) =>
  problems.length >= MAX_PROBLEMS || problems.includes(message) ? problems : [...problems, message]

const REPORTER = `(() => {
  if (window.parent === window) return
  const send = (message) => window.parent.postMessage({ type: "${PROBLEM_TYPE}", message: String(message).slice(0, ${MAX_MESSAGE_LENGTH}) }, "*")
  addEventListener("error", (event) => {
    const target = event.target
    if (target instanceof Element) {
      const url = target.getAttribute("src") || target.getAttribute("href")
      send(url ? "Could not load " + url : "A <" + target.localName + "> could not load one of its imports")
    }
    else send(event.error && event.error.stack ? event.error.stack.split("\\n")[0] : event.message)
  }, true)
  addEventListener("unhandledrejection", (event) => send("Unhandled rejection: " + ((event.reason && event.reason.message) || event.reason)))
  const original = console.error.bind(console)
  console.error = (...args) => {
    send(args.map(String).join(" "))
    original(...args)
  }
})()`

export const injectProblemReporter = (html: string) =>
  insertAtHeadStart(html, `<script id="hinacode-problems">${REPORTER}</script>`)
