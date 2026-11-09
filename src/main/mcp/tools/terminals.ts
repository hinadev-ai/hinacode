import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import type { TerminalSession } from "../../../shared/domain.ts"
import { terminalMention } from "../../../shared/mentions.ts"
import { Terminals } from "../../services/Terminals.ts"
import { terminalText } from "../../services/terminalText.ts"
import * as McpTool from "./tool.ts"

const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 2000

const terminalLabel = (session: TerminalSession, index: number) => session.title ?? `Terminal ${index + 1}`

const terminalStatus = (session: TerminalSession) => {
  if (session.status === "exited") return session.exitCode === null ? "exited" : `exited with code ${session.exitCode}`
  if (session.command !== null) return session.command === "" ? "running a command" : `running \`${session.command}\``
  if (session.lastExitCode !== null) return `idle, the last command exited with code ${session.lastExitCode}`
  return "running"
}

const describeTerminal = (session: TerminalSession, index: number) =>
  [
    `- ${terminalLabel(session, index)}`,
    `  id: ${session.id}`,
    `  mention: ${terminalMention(session.id)}`,
    `  cwd: ${session.cwd}`,
    `  status: ${terminalStatus(session)}`,
  ].join("\n")

export const TerminalTools = Toolkit.make(
  McpTool.make("list_terminals", {
    description:
      "List the terminals the user has open for this thread in HinaCode's terminal drawer, in the order of its tabs, with each one's id, cwd, status and the mention to write in your reply to point the user at it. For zsh, bash and fish the status names the command running in the foreground, or the exit code of the last one.",
  }).annotate(Tool.Readonly, true),
  McpTool.make("read_terminal", {
    description:
      "Read the recent output of one of this thread's terminals as plain text, without colors or cursor movement. Use it when the user mentions a terminal with @terminal:<id>. HinaCode keeps the last 256 KB of each terminal's output.",
    parameters: Schema.Struct({
      id: Schema.String.annotate({ description: "The terminal id, as in @terminal:<id> or list_terminals." }),
      lines: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_READ_LINES })).annotate({
          description: `How many of the last lines to return. Defaults to ${DEFAULT_READ_LINES}.`,
        }),
      ),
    }),
  }).annotate(Tool.Readonly, true),
)

export const terminalToolsLayer = TerminalTools.toLayer(
  Effect.gen(function* () {
    const terminals = yield* Terminals
    return TerminalTools.of({
      list_terminals: () =>
        McpTool.CallingThread.use((threadId) =>
          Effect.map(terminals.list(threadId), (sessions) =>
            sessions.length === 0
              ? "This thread has no open terminals."
              : sessions.map((session, index) => describeTerminal(session, index)).join("\n"),
          ),
        ),
      read_terminal: ({ id, lines }) =>
        McpTool.CallingThread.use((threadId) =>
          Effect.gen(function* () {
            const notFound = {
              message: `No open terminal of this thread has the id ${id}. Call list_terminals to see this thread's terminals.`,
            }
            const sessions = yield* terminals.list(threadId)
            const index = sessions.findIndex((session) => session.id === id)
            if (index === -1) return yield* Effect.fail(notFound)
            const { session, data } = yield* Effect.mapError(terminals.attach(id, null), () => notFound)
            const text = terminalText(data, lines ?? DEFAULT_READ_LINES, session.cols)
            return [
              `${terminalLabel(session, index)} (${terminalStatus(session)}) in ${session.cwd}`,
              "",
              text === "" ? "(no output)" : text,
            ].join("\n")
          }),
        ),
    })
  }),
)
