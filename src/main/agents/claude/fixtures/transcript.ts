import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { PUBLISH_ARTIFACT_TOOL } from "../../../../shared/agent.ts"
import type { MockStep } from "../play.ts"
import {
  assistant,
  compactBoundary,
  compactFailed,
  compacting,
  executionError,
  nextCallId,
  pngBlock,
  success,
  taskEnded,
  taskStarted,
  textDelta,
  thinkingDelta,
  toolResult,
  toolUse,
} from "./sdk.ts"

const sdk = (message: SDKMessage): MockStep => ({ type: "sdk", message })
const pause = (ms: number): MockStep => ({ type: "pause", ms })

const chunksOf = (text: string, size: number) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? []

const say = (text: string, contextTokens?: number): Array<MockStep> => [
  ...chunksOf(text, 12).flatMap((chunk) => [sdk(textDelta(chunk)), pause(25)]),
  sdk(assistant([{ type: "text", text, citations: [] }], { contextTokens })),
]

const think = (text: string): Array<MockStep> =>
  chunksOf(text, 16).flatMap((chunk) => [sdk(thinkingDelta(chunk)), pause(120)])

const tool = (
  name: string,
  input: Record<string, unknown>,
  output: Parameters<typeof toolResult>[1],
  { isError = false, runningMs = 250 }: { isError?: boolean; runningMs?: number } = {},
): Array<MockStep> => {
  const id = nextCallId()
  return [sdk(toolUse(id, name, input)), pause(runningMs), sdk(toolResult(id, output, { isError }))]
}

const red = (text: string) => `\u001b[31m${text}\u001b[39m`
const green = (text: string) => `\u001b[32m${text}\u001b[39m`
const dim = (text: string) => `\u001b[2m${text}\u001b[22m`

const numbered = (lines: ReadonlyArray<string>) =>
  lines.map((line, index) => `${String(index + 1).padStart(6)}→${line}`).join("\n")

const loginSource = [
  'import { redirect } from "./router.ts"',
  "",
  "export function afterLogin(session: Session, next: string | null) {",
  '  if (next === null) return redirect("/")',
  "  return redirect(next)",
  "}",
]

const vitestRun = [
  "",
  ` ${dim("RUN")}  v4.0.2 /work/demo-web`,
  "",
  ` ${green("✓")} src/auth/login.test.ts ${dim("(6 tests)")} 38ms`,
  ` ${green("✓")} src/auth/session.test.ts ${dim("(4 tests)")} 12ms`,
  "",
  ` ${dim("Test Files")}  ${green("2 passed")} (2)`,
  `      ${dim("Tests")}  ${green("10 passed")} (10)`,
].join("\n")

const failingRun = [
  ` ${red("FAIL")} src/auth/login.test.ts > afterLogin > rejects an external next URL`,
  `${red("AssertionError")}: expected '/https://evil.example' to be '/'`,
  "",
  `${dim("  ❯ src/auth/login.test.ts:24:31")}`,
  "",
  ` ${dim("Test Files")}  ${red("1 failed")} (1)`,
  "Exit code 1",
].join("\n")

const buildLog = Array.from(
  { length: 160 },
  (_, index) => `[${String(index).padStart(3, "0")}] transform src/module-${index}.ts ${dim(`${(index * 7) % 90}ms`)}`,
)
  .concat(["", green("built in 4.21s")])
  .join("\n")

const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

export const toolKinds = (): Array<MockStep> => [
  ...think("The redirect bug is probably in the login handler. I should find it, read it, then check the tests."),
  ...say("I'll find the login redirect first.\n\n"),
  ...tool(
    "Grep",
    { pattern: "afterLogin", path: "src", output_mode: "content" },
    'src/auth/login.ts:3:export function afterLogin(session: Session, next: string | null) {\nsrc/routes/callback.ts:18:  return afterLogin(session, url.searchParams.get("next"))',
  ),
  ...tool("Glob", { pattern: "src/auth/**/*.test.ts" }, "src/auth/login.test.ts\nsrc/auth/session.test.ts"),
  ...tool("Read", { file_path: "/work/demo-web/src/auth/login.ts" }, numbered(loginSource)),
  ...say("`afterLogin` trusts `next` as is. I'll keep only same-origin paths.\n\n"),
  ...tool(
    "Edit",
    {
      file_path: "/work/demo-web/src/auth/login.ts",
      old_string: "  return redirect(next)",
      new_string: '  return redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/")',
      replace_all: false,
    },
    "The file /work/demo-web/src/auth/login.ts has been updated successfully.",
  ),
  ...tool(
    "Write",
    {
      file_path: "/work/demo-web/src/auth/login.test.ts",
      content: 'import { expect, test } from "vitest"\n\ntest("rejects an external next URL", () => {})\n',
    },
    "File created successfully at: /work/demo-web/src/auth/login.test.ts",
  ),
  ...tool("Bash", { command: "pnpm vitest run src/auth", description: "Run the auth tests" }, vitestRun, {
    runningMs: 900,
  }),
  ...say("Tests pass. Let me check what OWASP says about open redirects.\n\n"),
  ...tool(
    "WebSearch",
    { query: "OWASP unvalidated redirects cheat sheet" },
    'Web search results for query: "OWASP unvalidated redirects cheat sheet"\n\n1. Unvalidated Redirects and Forwards Cheat Sheet (cheatsheetseries.owasp.org)',
  ),
  ...tool(
    "WebFetch",
    {
      url: "https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html",
      prompt: "How should a login redirect validate its target?",
    },
    "Validate the target against an allow-list of local paths and reject protocol-relative URLs such as //evil.example.",
  ),
  ...say("Updating the plan.\n\n"),
  ...tool(
    "TodoWrite",
    {
      todos: [
        { content: "Find the redirect handler", status: "completed", activeForm: "Finding the redirect handler" },
        { content: "Reject external next URLs", status: "completed", activeForm: "Rejecting external next URLs" },
        { content: "Open a pull request", status: "in_progress", activeForm: "Opening a pull request" },
        { content: "Post the PR on the Linear issue", status: "pending", activeForm: "Posting the PR on Linear" },
      ],
    },
    "Todos have been modified successfully.",
  ),
  ...say("Loading the pull request skill.\n\n"),
  ...tool("Skill", { skill: "create-pr" }, "Launching skill: create-pr"),
  ...say("Checking the Linear issue.\n\n"),
  ...tool(
    "mcp__linear__get_issue",
    { id: "WEB-142" },
    JSON.stringify(
      { identifier: "WEB-142", title: "Login redirects to external sites", state: "In Progress" },
      null,
      2,
    ),
  ),
  ...subagent(),
  ...artifact("Open redirect fix summary"),
  ...say(
    "Fixed the open redirect in `src/auth/login.ts`.\n\n| Check | Result |\n| --- | --- |\n| Unit tests | 10 passed |\n| External `next` | Redirects to `/` |\n",
    142_000,
  ),
]

function subagent(): Array<MockStep> {
  const id = nextCallId()
  const read = nextCallId()
  const grep = nextCallId()
  return [
    sdk(
      toolUse(id, "Agent", {
        description: "Audit other redirects",
        prompt: "Find every other place that redirects to a URL taken from the request.",
        subagent_type: "general-purpose",
      }),
    ),
    sdk(taskStarted("mock-task-redirects", id, "Audit other redirects")),
    sdk(toolUse(grep, "Grep", { pattern: "redirect\\(", path: "src" }, id)),
    sdk(toolResult(grep, "src/auth/login.ts:5\nsrc/routes/logout.ts:9", { parentCallId: id })),
    sdk(toolUse(read, "Read", { file_path: "/work/demo-web/src/routes/logout.ts" }, id)),
    sdk(toolResult(read, numbered(['  return redirect("/")']), { parentCallId: id })),
    pause(600),
    sdk(taskEnded("mock-task-redirects", id, "completed", "Only login.ts redirects to a request-supplied URL.")),
    sdk(toolResult(id, "Only login.ts redirects to a request-supplied URL. logout.ts always goes to /.")),
  ]
}

function artifact(title: string): Array<MockStep> {
  const callId = nextCallId()
  const input = {
    title,
    files: [
      {
        path: "index.html",
        content: `<!doctype html><html><body style="font: 16px/1.5 system-ui; margin: 32px"><h1>${title}</h1><p>External next URLs now redirect to /.</p></body></html>`,
      },
    ],
  }
  return [
    sdk(toolUse(callId, `mcp__hinacode__${PUBLISH_ARTIFACT_TOOL}`, input)),
    { type: "publish_artifact", callId, input },
  ]
}

export const toolStates = (): Array<MockStep> => [
  ...say("Each tool below ends in a different state.\n\n"),
  ...tool("Bash", { command: "pnpm build", description: "Build for production" }, buildLog, { runningMs: 3000 }),
  ...tool("Bash", { command: "git stash list", description: "List stashes" }, ""),
  ...tool("Bash", { command: "pnpm vitest run src/auth/login.test.ts" }, failingRun, { isError: true }),
  ...tool(
    "Read",
    { file_path: "/work/demo-web/src/auth/missing.ts" },
    "<tool_use_error>File does not exist. Note: your current working directory is /work/demo-web.</tool_use_error>",
    { isError: true },
  ),
  ...tool("Read", { file_path: "/work/demo-web/public/logo.png" }, [pngBlock(onePixelPng)]),
  ...tool(
    "mcp__linear__update_issue",
    { id: "WEB-142", state: "Done" },
    "MCP error -32603: Linear API returned 401 Unauthorized",
    { isError: true },
  ),
  ...tool(
    "mcp__hinacode__link_pull_request",
    { url: "https://github.com/hinadev-ai/hinacode/pull/607" },
    "Linked the pull request.",
  ),
  ...tool(
    "mcp__hinacode__watch_pull_request",
    { url: "https://github.com/hinadev-ai/hinacode/pull/607" },
    "Watching the pull request.",
  ),
  ...tool("mcp__hinacode__list_artifacts", {}, "[]"),
  ...tool("mcp__hinacode__publish_artifact", { title: "Tool Output Variants", files: [] }, "The page is too large.", {
    isError: true,
  }),
  ...say("The build log is long, so only its tail ships with the transcript.", 61_000),
]

export const thinkingStream = (): Array<MockStep> => [
  ...think(
    "The user wants the session cookie to survive a restart. The cookie is set in `session.ts` without `Max-Age`, so the browser drops it when it closes. Adding `Max-Age` fixes it, but the server-side store also expires idle sessions after 30 minutes, so I need to raise that too or the cookie will point at a dead session.",
  ),
  ...say(
    'The cookie is a session cookie, so the browser drops it on close.\n\n1. Add `Max-Age=2592000` to the `Set-Cookie` header.\n2. Raise the idle timeout in `SessionStore` from 30 minutes to 30 days.\n\n```ts\nres.setHeader("Set-Cookie", `sid=${id}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`)\n```\n',
    38_000,
  ),
]

export const compaction = (): Array<MockStep> => [
  ...say("The context is almost full, so it gets summarized.\n\n"),
  sdk(compacting()),
  pause(2000),
  sdk(compactBoundary("auto", 183_000, 21_000)),
  ...say("Picked up from the summary. A manual compaction now fails.\n\n"),
  sdk(compacting()),
  pause(1000),
  sdk(compactFailed("Conversation too long to summarize")),
]

const approved = (
  name: string,
  input: Record<string, unknown>,
  request: Extract<MockStep, { type: "approval" }>["request"],
  output: string,
): Array<MockStep> => {
  const callId = nextCallId()
  return [sdk(toolUse(callId, name, input)), { type: "approval", callId, request, output }]
}

export const approvals = (): Array<MockStep> => [
  ...say("A few calls need your approval. Allow some and deny others to see both results.\n\n"),
  ...approved(
    "Bash",
    { command: "pnpm install", description: "Install dependencies" },
    {
      kind: "command",
      title: "Install dependencies",
      detail: "pnpm install",
      sessionScope: { tool: "Bash", kind: "command", value: "pnpm install" },
    },
    "Packages: +412\nDone in 3.2s using pnpm v10.12.1",
  ),
  ...approved(
    "Edit",
    { file_path: "/work/demo-web/.env", old_string: "API_URL=", new_string: "API_URL=https://api.example.com" },
    {
      kind: "patch",
      title: "Edit .env",
      detail: "/work/demo-web/.env",
      sessionScope: { tool: "Edit", kind: "path", value: "/work/demo-web/.env" },
    },
    "The file /work/demo-web/.env has been updated successfully.",
  ),
  ...approved(
    "WebFetch",
    { url: "https://registry.npmjs.org/vite", prompt: "What is the latest version?" },
    {
      kind: "tool",
      title: "Fetch registry.npmjs.org",
      detail: "https://registry.npmjs.org/vite",
      sessionScope: { tool: "WebFetch", kind: "domain", value: "registry.npmjs.org" },
    },
    "The latest version is 8.1.0.",
  ),
  ...approved(
    "mcp__linear__create_comment",
    { issueId: "WEB-142", body: "Fixed in #128" },
    {
      kind: "tool",
      title: "linear: create_comment",
      detail: JSON.stringify({ issueId: "WEB-142", body: "Fixed in #128" }),
      sessionScope: { tool: "mcp__linear__create_comment", kind: "tool", value: "mcp__linear__create_comment" },
    },
    "Comment created.",
  ),
  {
    type: "question",
    questions: [
      {
        id: "port",
        header: "Dev server",
        question: "Which port should the dev server use?",
        options: [
          { label: "3000", description: "The project default" },
          { label: "5173", description: "Vite's default" },
        ],
        multiSelect: false,
        allowsText: true,
        secret: false,
      },
      {
        id: "checks",
        header: "Checks",
        question: "Which checks should run before the server starts?",
        options: [
          { label: "Typecheck", description: "" },
          { label: "Lint", description: "" },
          { label: "Unit tests", description: "Slower, about a minute" },
        ],
        multiSelect: true,
        allowsText: false,
        secret: false,
      },
      {
        id: "branch",
        header: "",
        question: "What should the preview branch be called?",
        options: [],
        multiSelect: false,
        allowsText: true,
        secret: false,
      },
    ],
  },
  ...say("Thanks. The dev server will use those settings.", 52_000),
]

export const failure = (): Array<MockStep> => [
  ...say("Running the migration.\n\n"),
  ...tool("Bash", { command: "pnpm db:migrate", description: "Apply migrations" }, "Applied 0041_threads_index"),
  sdk(executionError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')),
]

export const signedOutMessage = "Failed to authenticate: OAuth session expired and could not be refreshed"

export const signedOut = (): Array<MockStep> => [
  sdk({
    ...assistant([{ type: "text", text: signedOutMessage, citations: null }], { contextTokens: 0 }),
    error: "authentication_failed" as const,
  }),
  sdk({ ...success(), is_error: true, result: signedOutMessage }),
]

export const stoppable = (): Array<MockStep> => {
  const watch = nextCallId()
  return [
    ...think("Running the tests in watch mode, then reporting each change."),
    sdk(toolUse(watch, "Bash", { command: "pnpm vitest --watch", description: "Watch the unit tests" })),
    ...Array.from({ length: 40 }, (_, index) => [
      ...say(`Change ${index + 1} picked up, tests still green. `),
      pause(500),
    ]).flat(),
    { type: "until_stopped" },
  ]
}

export const everything = (): Array<MockStep> => [
  ...toolKinds(),
  ...say("\n\n"),
  ...toolStates(),
  ...say("\n\n"),
  ...thinkingStream(),
  ...compaction(),
  ...approvals(),
]

export const finished = (): MockStep => sdk(success())
